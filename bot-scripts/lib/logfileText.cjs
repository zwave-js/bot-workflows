const markdownLinkRegex = /\[.*\]\((http.*?)\)/;
const codeBlockRegex = /`{3,4}(.*?)`{3,4}/s;

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
 * Decompresses zipped or gzipped logfile uploads, following the pattern
 * of tryUnzipFirmwareFile in @zwave-js/core. Returns the data unchanged
 * when it is not compressed or no single logfile can be identified -
 * the logfile classifier then flags it as binary.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function maybeDecompressLogfile(data) {
	const isZip = data[0] === 0x50
		&& data[1] === 0x4b
		&& data[2] === 0x03
		&& data[3] === 0x04;
	const isGzip = data[0] === 0x1f && data[1] === 0x8b;
	if (!isZip && !isGzip) return data;

	// Lazy import, so bot scripts that never see compressed uploads work
	// without node_modules. Workflows that extract logfiles must install
	// dependencies - a missing module should fail the run, not degrade
	// into "binary file" feedback.
	const { gunzipSync, unzipSync } = require("fflate");
	try {
		if (isZip) {
			const unzipped = unzipSync(data, {
				filter: (file) =>
					/\.(log|txt)$/i.test(file.name)
					// macOS zips contain resource-fork copies of each file
					&& !file.name.startsWith("__MACOSX/")
					&& !file.name.split("/").pop()?.startsWith("._"),
			});
			let names = Object.keys(unzipped);
			if (names.length > 1) {
				// Prefer the driver log when other logs are bundled along,
				// and the active logfile over rotated ones
				const zjsLogs = names.filter((name) => /zwavejs_/.test(name));
				if (zjsLogs.length > 0) names = zjsLogs;
				const current = names.find((name) =>
					name.endsWith("zwavejs_current.log")
				);
				if (current) names = [current];
			}
			if (names.length === 1) return unzipped[names[0]];
		} else {
			return gunzipSync(data);
		}
	} catch (e) {
		// Corrupted or password-protected archives get binary-file feedback
		console.error("Failed to decompress logfile:", e);
	}
	return data;
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
			const data = maybeDecompressLogfile(
				new Uint8Array(await resp.arrayBuffer()),
			);
			const logFile = new TextDecoder().decode(data);
			// limit to the last 250 lines
			return logFile.split("\n").slice(-250).join("\n");
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
	maybeDecompressLogfile,
};
