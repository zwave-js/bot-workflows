// @ts-check

/// <reference path="../types.d.ts" />

// Public entry points of the docs-answer pipeline. prepareDocsAnswer runs
// before the agentic judge, postDocsAnswer runs as its safe-output job.

const fs = require("node:fs/promises");
const { EMBEDDING_MODEL, embed } = require("../indexes/localEmbeddings.cjs");
const { cleanQuestion } = require("../indexes/postsIndex.cjs");
const { checkAnswerGates, checkSuppression } = require("./gate.cjs");
const { composeAndPostAnswer, postDocsAnswer } = require("./post.cjs");
const { buildRelatedPostsSection, writeHandoff } = require("./render.cjs");
const { loadIndexes, retrieveDocsChunks } = require("./retrieve.cjs");

/**
 * Prepares answering a user's question in an issue or discussion:
 * retrieves documentation excerpts for the agentic judge, and posts
 * related-posts-only suggestions directly when the docs have nothing
 * to offer.
 *
 * Expects the following environment variables:
 * - DOCS_INDEX_PATH: path to the embeddings index created by buildDocsIndex.cjs
 * - POSTS_INDEX_PATH: path to the embeddings index created by buildPostsIndex.cjs
 * - DOCS_FEEDBACK_PATH: path to the suppression list created by collectDocsFeedback.cjs
 * - DOCS_HANDOFF_PATH: where to write the handoff file for the judge
 *
 * @param {{github: Github, context: Context}} param
 * @returns {Promise<boolean>} Whether the agentic judge should run
 */
async function prepareDocsAnswer(param) {
	const gates = await checkAnswerGates(param);
	if (!gates) return false;
	const { post, isDiscussion } = gates;

	const { docsIndex, postsIndex } = await loadIndexes();
	if (!docsIndex && !postsIndex) return false;

	const question = cleanQuestion(post.title, post.body ?? "");
	const [questionEmbedding] = await embed([question]);

	// Feedback guardrail: check the question against previously
	// downvoted answers collected by collectDocsFeedback.cjs
	let suppression = "allow";
	const feedbackPath = process.env.DOCS_FEEDBACK_PATH;
	if (feedbackPath) {
		/** @type {any} */
		let feedback;
		try {
			feedback = JSON.parse(await fs.readFile(feedbackPath, "utf8"));
		} catch {
			console.log(`No feedback data found at ${feedbackPath}`);
		}
		suppression = checkSuppression(
			questionEmbedding,
			feedback,
			EMBEDDING_MODEL,
		);
	}

	const chunks = docsIndex && suppression !== "silent"
		? retrieveDocsChunks(question, questionEmbedding, docsIndex)
		: undefined;

	const postsSection = postsIndex
		? buildRelatedPostsSection(postsIndex, questionEmbedding, {
			type: isDiscussion ? "discussion" : "issue",
			number: post.number,
		})
		: undefined;

	if (chunks) {
		// Hand off to the agentic judge, which decides whether the docs
		// answer the question. Posting moves to the judge's safe-output job,
		// so the related-posts section survives a low-confidence verdict.
		const handoffPath = process.env.DOCS_HANDOFF_PATH;
		if (!handoffPath) {
			throw new Error(
				"DOCS_HANDOFF_PATH environment variable is required",
			);
		}
		await writeHandoff(handoffPath, {
			question,
			allowAnswer: suppression === "allow",
			chunks,
			postsSection: postsSection ?? null,
		});
		return true;
	}

	if (postsSection) {
		await composeAndPostAnswer(
			param,
			post,
			isDiscussion,
			undefined,
			postsSection,
		);
		return false;
	}

	console.log("Nothing to answer or suggest, skipping");
	return false;
}

module.exports = {
	prepareDocsAnswer,
	postDocsAnswer,
};
