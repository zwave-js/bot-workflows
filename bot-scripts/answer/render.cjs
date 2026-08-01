// @ts-check

// Renders the docs and related-posts sections of the answer comment,
// validates the judge's verdict, and writes the handoff for the judge.

const fs = require("node:fs/promises");
const path = require("node:path");
const { config } = require("../config.cjs");
const { rankRelatedPosts } = require("../indexes/postsIndex.cjs");
const { sanitizeModelAnswer } = require("../lib/sanitizeAnswer.cjs");

// Confidence thresholds for the different response styles
const ANSWER_CONFIDENCE = 75;
const LINKS_CONFIDENCE = 40;

// A related post is only suggested above this cosine similarity; kept high
// because a wrong suggestion is worse than a missed one. Calibrated for
// all-MiniLM-L6-v2: known-duplicate eval pairs score 0.52-0.81
const POSTS_MIN_SIMILARITY = 0.6;
const MAX_RELATED_POSTS = 3;
// Cap the answer so a runaway completion cannot 422 the comment API
const MAX_ANSWER_LENGTH = 15000;

/**
 * Closes a fenced code block left open when the length cap slices inside one,
 * so the truncation cannot swallow the doc-links list rendered after it.
 * @param {string} text
 */
function balanceCodeFences(text) {
	const fences = text.match(/^[ \t]*(?:`{3,}|~{3,})/gm) ?? [];
	if (fences.length % 2 === 0) return text;
	const marker = fences[fences.length - 1].replace(/^[ \t]+/, "");
	return `${text}\n${marker}`;
}

/** @param {{file: string, anchor: string}} chunk */
function chunkUrl(chunk) {
	const docPath = chunk.file.replace(/(README|index)?\.md$/, "");
	let url = `${config.docs.baseUrl}/${docPath}`;
	if (chunk.anchor) url += `?id=${chunk.anchor}`;
	return url;
}

/**
 * Extracts the excerpt ids from the judge's tool argument, which arrives as a
 * string whose ids may be joined by any separator ("2, 0", "1;2")
 * @param {unknown} raw
 * @returns {number[]}
 */
function parseRelatedExcerpts(raw) {
	return [...String(raw ?? "").matchAll(/\d+/g)].map((m) =>
		Number.parseInt(m[0], 10)
	);
}

/**
 * Validates the shape of the judge's verdict, which is untrusted model
 * output: it can contain out-of-range numbers, wrong types, or omit
 * fields entirely. Malformed output degrades to a safe "no answer"
 * result instead of throwing.
 * @param {any} parsed
 * @returns {{confidence: number, answer: string | null, relatedExcerpts: number[]}}
 */
function validateJudgeResponse(parsed) {
	const noAnswer = { confidence: 0, answer: null, relatedExcerpts: [] };
	if (!parsed || typeof parsed !== "object") return noAnswer;

	const { confidence } = parsed;
	if (
		typeof confidence !== "number"
		|| !Number.isFinite(confidence)
		|| confidence < 0
		|| confidence > 100
	) {
		return noAnswer;
	}

	const answer = typeof parsed.answer === "string"
		? balanceCodeFences(parsed.answer.slice(0, MAX_ANSWER_LENGTH))
		: null;

	const relatedExcerpts = Array.isArray(parsed.relatedExcerpts)
		? parsed.relatedExcerpts.filter(
			(/** @type {any} */ i) => Number.isInteger(i) && i >= 0,
		)
		: [];

	return { confidence, answer, relatedExcerpts };
}

/**
 * Renders the docs part of the comment from the judge's verdict
 * @param {{confidence: number, answer: string | null, relatedExcerpts: number[]}} result A validated judge response
 * @param {any[]} chunks The chunks the judge was given, most relevant first
 * @param {boolean} allowAnswer Render doc links only when false
 * @returns {{text: string, style: "answer" | "links", confidence: number, sections: string[]} | undefined}
 */
function renderDocsSection(result, chunks, allowAnswer) {
	const related = (result.relatedExcerpts ?? [])
		.map((i) => chunks[i])
		.filter(Boolean);

	if (result.confidence < LINKS_CONFIDENCE || related.length === 0) {
		console.log("Confidence too low, not answering");
		return;
	}

	// When linking to a section, don't also link to its subsections
	const isAncestor = (
		/** @type {any} */ a,
		/** @type {any} */ b,
	) => a.file === b.file
		&& a.breadcrumbs.length < b.breadcrumbs.length
		&& a.breadcrumbs.every(
			(/** @type {string} */ crumb, /** @type {number} */ i) =>
				crumb === b.breadcrumbs[i],
		);
	// Sub-splits of the same section share a URL, only link it once
	/** @type {Set<string>} */
	const seenUrls = new Set();
	const deduped = related.filter((chunk) => {
		if (related.some((other) => isAncestor(other, chunk))) return false;
		const url = chunkUrl(chunk);
		if (seenUrls.has(url)) return false;
		seenUrls.add(url);
		return true;
	});

	const links = deduped
		.map((chunk) => {
			// breadcrumbs is normally never empty (buildDocsIndex.cjs falls
			// back to the chunk title for pre-heading content), but an older
			// cached index could still have one - keep the label nonempty
			const label = chunk.breadcrumbs.join(" → ") || chunk.title;
			return `- [${label}](${chunkUrl(chunk)})`;
		})
		.join("\n");

	const sections = deduped.map((chunk) => `${chunk.file}#${chunk.anchor}`);
	const single = deduped.length === 1;
	// The model's answer is untrusted output - sanitize it before it is
	// ever rendered in the comment. The doc links below are generated
	// from our own index data and must NOT be sanitized the same way.
	const sanitizedAnswer = result.answer
		? sanitizeModelAnswer(result.answer)
		: null;
	if (
		allowAnswer && result.confidence >= ANSWER_CONFIDENCE && sanitizedAnswer
	) {
		return {
			text: `${sanitizedAnswer}

${
				single
					? "This section of the documentation has more details:"
					: "These sections of the documentation have more details:"
			}
${links}`,
			style: "answer",
			confidence: result.confidence,
			sections,
		};
	} else {
		return {
			text: `${
				single
					? "This section of the documentation might answer your question:"
					: "These sections of the documentation might answer your question:"
			}

${links}`,
			style: "links",
			confidence: result.confidence,
			sections,
		};
	}
}

/** @param {import("../indexes/postsIndex.cjs").IndexedPost} post */
function describePostState(post) {
	if (post.type === "issue") {
		return post.state === "open" ? "open issue" : "closed issue";
	}
	if (post.state === "answered") return "answered discussion";
	if (post.state === "closed") return "closed discussion";
	return "discussion";
}

/**
 * Ranks existing posts by similarity and renders the related-posts part
 * of the comment
 * @param {NonNullable<Awaited<ReturnType<import("../indexes/postsIndex.cjs")["loadPostsIndex"]>>>} index
 * @param {number[]} questionEmbedding
 * @param {{type: "issue" | "discussion", number: number}} self
 * @returns {string | undefined}
 */
function buildRelatedPostsSection(index, questionEmbedding, self) {
	// Log more candidates than are shown, as tuning signal for the floor
	const candidates = rankRelatedPosts(index, questionEmbedding, self, {
		minSimilarity: 0,
		maxResults: 10,
	});
	console.log(
		"Top related posts:",
		candidates.map((c) =>
			`cos=${c.similarity.toFixed(3)} ${c.post.type} #${c.post.number}`
		),
	);

	const shown = candidates
		.filter((c) => c.similarity >= POSTS_MIN_SIMILARITY)
		.slice(0, MAX_RELATED_POSTS);
	if (shown.length === 0) {
		console.log("No sufficiently similar posts found");
		return;
	}

	const links = shown
		.map(({ post }) => {
			// Backslashes and square brackets in titles would break the markdown link
			const title = post.title.replace(/[\\[\]]/g, "\\$&");
			return `- [${title}](${post.url}) (${describePostState(post)})`;
		})
		.join("\n");

	return `${
		shown.length === 1
			? "This existing post looks similar to yours and might be related — a maintainer will confirm:"
			: "These existing posts look similar to yours and might be related — a maintainer will confirm:"
	}

${links}`;
}

/**
 * Writes the handoff for the agentic judge: the full handoff for the
 * safe-output job, plus a projected judge-input.json next to it.
 * @param {string} handoffPath
 * @param {{question: string, allowAnswer: boolean, chunks: any[], postsSection: string | null}} handoff
 */
async function writeHandoff(handoffPath, handoff) {
	await fs.mkdir(path.dirname(handoffPath), { recursive: true });
	await fs.writeFile(handoffPath, JSON.stringify(handoff));
	// The judge only needs the question and the excerpt text - the
	// full chunks carry embedding vectors that would be pure noise
	// in its context
	await fs.writeFile(
		path.join(path.dirname(handoffPath), "judge-input.json"),
		JSON.stringify({
			question: handoff.question,
			excerpts: handoff.chunks.map(({ breadcrumbs, text }) => ({
				breadcrumbs,
				text,
			})),
		}),
	);
	console.log(`Wrote handoff for the judge to ${handoffPath}`);
}

module.exports = {
	POSTS_MIN_SIMILARITY,
	balanceCodeFences,
	buildRelatedPostsSection,
	chunkUrl,
	parseRelatedExcerpts,
	renderDocsSection,
	validateJudgeResponse,
	writeHandoff,
};
