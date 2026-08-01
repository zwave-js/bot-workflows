const markdownLinkRegex = /\[.*\]\((http.*?)\)/;
const codeBlockRegex = /`{3,4}(.*?)`{3,4}/s;

// Plaintext logfiles may be up to 2 GB, but zipping one that large is a sign
// that something other than a driver log was uploaded
const MAX_ARCHIVE_SIZE = 250 * 1024 * 1024;
// The classifier only looks at line patterns, so the tail is enough
const LOGFILE_TAIL_LINES = 250;
const INFLATE_CHUNK_SIZE = 1024 * 1024;

/**
 * Extract logfile section from discussion body
 * @param {string} body - Discussion body
 * @returns {string} - Logfile section content
 */
function extractLogfileSection(body) {
	const logfileSectionHeader = "### Upload Logfile";

	if (!body.includes(logfileSectionHeader)) {
		throw new Error("No logfile section found in discussion");
	}

	return body.slice(
		body.indexOf(logfileSectionHeader) + logfileSectionHeader.length,
	);
}

/**
 * Extract and validate URL from logfile section
 * @param {string} logfileSection - Logfile section content
 * @returns {string} - Valid logfile URL
 */
function extractLogfileUrl(logfileSection) {
	const linkMatch = markdownLinkRegex.exec(logfileSection);
	if (!linkMatch || !linkMatch[1]) {
		throw new Error("No valid logfile URL found in discussion");
	}

	const url = linkMatch[1].trim();

	// Validate URL format
	try {
		return new URL(url).toString();
	} catch (error) {
		throw new Error(`Invalid URL format: ${url}`);
	}
}

/**
 * Detects zipped or gzipped logfile uploads by their magic bytes
 * @param {Uint8Array} data
 * @returns {"zip" | "gzip" | undefined}
 */
function compressedUploadKind(data) {
	if (
		data[0] === 0x50
		&& data[1] === 0x4b
		&& data[2] === 0x03
		&& data[3] === 0x04
	) {
		return "zip";
	}
	if (data[0] === 0x1f && data[1] === 0x8b) return "gzip";
}

/**
 * @param {string} name
 */
function isLogfileEntry(name) {
	return /\.(log|txt)$/i.test(name)
		// macOS zips contain resource-fork copies of each file
		&& !name.startsWith("__MACOSX/")
		&& !name.split("/").pop()?.startsWith("._");
}

/**
 * Picks the logfile to analyze from the entry names of a zipped upload.
 * @param {string[]} names
 * @returns {string | undefined} - undefined when no single candidate can be identified
 */
function pickLogfileFromArchive(names) {
	let candidates = names.filter(isLogfileEntry);
	if (candidates.length > 1) {
		// Prefer the driver log when other logs are bundled along,
		// and the active logfile over rotated ones
		const zjsLogs = candidates.filter((name) => /zwavejs_/.test(name));
		if (zjsLogs.length > 0) candidates = zjsLogs;
		const current = candidates.find((name) =>
			name.endsWith("zwavejs_current.log")
		);
		if (current) candidates = [current];
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Collects the trailing lines of a text stream, holding on to no more than
 * those lines
 * @param {number} maxLines
 */
function createTailCollector(maxLines) {
	const decoder = new TextDecoder();
	/** @type {string[]} */
	let lines = [];
	let partial = "";

	/** @param {string} text */
	function add(text) {
		const split = text.split("\n");
		partial = split.pop() ?? "";
		for (const line of split) lines.push(line);
		if (lines.length > maxLines) lines = lines.slice(-maxLines);
	}

	return {
		/** @param {Uint8Array} chunk */
		push(chunk) {
			add(partial + decoder.decode(chunk, { stream: true }));
		},
		end() {
			add(partial + decoder.decode());
			if (partial) lines.push(partial);
			return lines.slice(-maxLines).join("\n");
		},
	};
}

/**
 * Decodes the head of an upload that could not be decompressed, so the
 * classifier sees the magic bytes and reports a binary file
 * @param {Uint8Array} data
 */
function binarySample(data) {
	return new TextDecoder().decode(data.subarray(0, 8192));
}

/**
 * @param {Uint8Array} data - The buffered zip archive
 * @param {ReturnType<typeof createTailCollector>} tail
 */
function readZippedLogfileTail(data, tail) {
	const { Unzip, UnzipInflate, unzipSync } = require("fflate");
	try {
		/** @type {string[]} */
		const names = [];
		// Returning false from the filter collects the entry names without
		// inflating anything
		unzipSync(data, {
			filter: (file) => {
				names.push(file.name);
				return false;
			},
		});
		const name = pickLogfileFromArchive(names);
		if (name) {
			// Inflate only the picked entry, and only far enough to keep its
			// tail - the decompressed log can exceed the maximum string length
			const unzip = new Unzip((file) => {
				if (file.name !== name) return;
				file.ondata = (err, chunk) => {
					if (err) throw err;
					tail.push(chunk);
				};
				file.start();
			});
			unzip.register(UnzipInflate);
			// Inflate emits one chunk per push, so feed the archive in slices
			// rather than in one call
			for (let i = 0; i < data.length; i += INFLATE_CHUNK_SIZE) {
				const end = i + INFLATE_CHUNK_SIZE;
				unzip.push(data.subarray(i, end), end >= data.length);
			}
			return tail.end();
		}
	} catch (e) {
		// Corrupted or password-protected archives get binary-file feedback
		console.error("Failed to decompress logfile:", e);
	}
	return binarySample(data);
}

/**
 * Reads the trailing lines of a logfile response, decompressing zipped or
 * gzipped uploads on the fly. Uploads are allowed to be gigabytes large, so
 * only the tail - and, for zips, the compressed bytes - is held in memory.
 * @param {Response} resp
 * @returns {Promise<string>}
 */
async function readLogfileTail(resp) {
	if (!resp.body) return "";

	const tail = createTailCollector(LOGFILE_TAIL_LINES);
	/** @type {"zip" | "gzip" | undefined} */
	let kind;
	/** @type {import("fflate").Gunzip | undefined} */
	let gunzip;
	/** @type {Uint8Array[]} */
	const zipChunks = [];
	let zipSize = 0;
	let oversized = false;
	let first = true;

	for await (const chunk of resp.body) {
		if (first) {
			first = false;
			// Lazy import, so bot scripts that never see compressed uploads
			// work without node_modules. Workflows that extract logfiles must
			// install dependencies - a missing module should fail the run, not
			// degrade into "binary file" feedback.
			kind = compressedUploadKind(chunk);
			if (kind === "gzip") {
				const { Gunzip } = require("fflate");
				gunzip = new Gunzip((data) => tail.push(data));
			}
		}

		if (kind === "zip") {
			// A zip can only be read once its central directory has arrived
			zipSize += chunk.length;
			if (zipSize > MAX_ARCHIVE_SIZE) {
				oversized = true;
				break;
			}
			zipChunks.push(chunk);
		} else if (gunzip) {
			gunzip.push(chunk);
		} else {
			tail.push(chunk);
		}
	}

	if (kind === "zip") {
		const data = new Uint8Array(zipSize);
		let offset = 0;
		for (const chunk of zipChunks) {
			data.set(chunk, offset);
			offset += chunk.length;
		}
		if (oversized) return binarySample(data);
		return readZippedLogfileTail(data, tail);
	}
	if (gunzip) gunzip.push(new Uint8Array(0), true);
	return tail.end();
}

/**
 * Extract logfile content from logfile section (URL or code block)
 * @param {string} logfileSection - Logfile section content
 * @returns {Promise<string|null>} - Logfile content or error codes
 */
async function extractLogfileContent(logfileSection) {
	const link = markdownLinkRegex.exec(logfileSection)?.[1]?.trim();
	const codeBlockContent = codeBlockRegex.exec(logfileSection)?.[1]?.trim();

	if (link) {
		try {
			const resp = await fetch(link);
			if (!resp.ok) {
				console.error(
					`Failed to fetch logfile from ${link}:`,
					resp.statusText,
				);
				return "ERROR_FETCH";
			}
			return await readLogfileTail(resp);
		} catch (e) {
			console.error(`Failed to fetch logfile from ${link}:`, e);
			return "ERROR_FETCH";
		}
	} else if (codeBlockContent) {
		if (codeBlockContent.split("\n").length > 20) {
			// This code block is too long and should be a logfile instead
			return "ERROR_CODE_BLOCK_TOO_LONG";
		}
		return codeBlockContent;
	}

	return null;
}

module.exports = {
	extractLogfileSection,
	extractLogfileUrl,
	extractLogfileContent,
	compressedUploadKind,
	pickLogfileFromArchive,
	readLogfileTail,
	MAX_ARCHIVE_SIZE,
};
