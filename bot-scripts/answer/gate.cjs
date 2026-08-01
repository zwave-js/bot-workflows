// @ts-check

/// <reference path="../types.d.ts" />

// Eligibility gates for the docs-answer pipeline: author/category checks,
// duplicate-answer detection, and the downvote-based suppression guardrail.

const { excludedUsers } = require("../config.cjs");
const { cosineSimilarity } = require("../indexes/docsIndex.cjs");
const { QUESTION_CATEGORY_SLUGS } = require("../indexes/postsIndex.cjs");
const {
	listCommentsSinceTransfer,
	postFromContext,
} = require("../lib/comments.cjs");

const DOCS_ANSWER_COMMENT_TAG = "<!-- DOCS_ANSWER_COMMENT_TAG -->";

// Bound comment pagination so a malformed pageInfo cannot loop to the timeout
const MAX_COMMENT_PAGES = 20;

// Questions at least this similar to a previously downvoted answer
// get a demoted response: full answer -> links only, links only -> silence
const SUPPRESS_SIMILARITY = 0.9;

/**
 * Checks whether the bot already answered this post, paginating through
 * all comments so a busy post cannot hide an existing answer.
 * @param {{github: Github, context: Context}} param0
 * @param {any} post
 * @param {boolean} isDiscussion
 */
async function alreadyAnswered({ github, context }, post, isDiscussion) {
	if (isDiscussion) {
		// Discussions have no timeline API, so an answer inherited from a
		// transfer cannot be told apart from ours
		/** @type {string | null} */
		let cursor = null;
		// Bound the walk: a null endCursor returned alongside hasNextPage would
		// otherwise reset to page 1 and loop until the job times out
		for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
			const data = await github.graphql(
				`
				query getComments($discussionId: ID!, $cursor: String) {
					node(id: $discussionId) {
						... on Discussion {
							comments(first: 100, after: $cursor) {
								pageInfo { hasNextPage endCursor }
								nodes { body }
							}
						}
					}
				}
				`,
				{ discussionId: post.node_id, cursor },
			);
			const comments = data.node?.comments;
			if (
				comments?.nodes?.some(
					(/** @type {any} */ c) =>
						c.body.includes(DOCS_ANSWER_COMMENT_TAG),
				)
			) {
				return true;
			}
			const pageInfo = comments?.pageInfo;
			if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return false;
			cursor = pageInfo.endCursor;
		}
		console.log(
			`::warning::Stopped scanning discussion comments after ${MAX_COMMENT_PAGES} pages`,
		);
		return false;
	} else {
		const comments = await listCommentsSinceTransfer(
			github,
			context.repo.owner,
			context.repo.repo,
			post.number,
		);
		return comments.some((c) => c.body?.includes(DOCS_ANSWER_COMMENT_TAG));
	}
}

/**
 * Determines how the answer to a question must be demoted based on
 * its similarity to previously downvoted answers: a downvoted full
 * answer allows links only, downvoted links mean staying silent
 * @param {number[]} questionEmbedding
 * @param {{model: string, suppressed: {embedding: number[], style: string, url: string}[]} | undefined} feedback
 * @param {string} embeddingModel
 * @returns {"allow" | "linksOnly" | "silent"}
 */
function checkSuppression(questionEmbedding, feedback, embeddingModel) {
	// Embeddings from different models are not comparable
	if (!feedback || feedback.model !== embeddingModel) return "allow";

	/** @type {"allow" | "linksOnly" | "silent"} */
	let result = "allow";
	for (const entry of feedback.suppressed ?? []) {
		// The cache could be stale or corrupted. Skip malformed entries,
		// a mismatched vector length would yield NaN below
		if (
			!Array.isArray(entry.embedding)
			|| entry.embedding.length !== questionEmbedding.length
		) {
			continue;
		}
		const similarity = cosineSimilarity(
			questionEmbedding,
			entry.embedding,
		);
		if (!(similarity >= SUPPRESS_SIMILARITY)) continue;
		console.log(
			`Question is similar (${
				similarity.toFixed(3)
			}) to a downvoted answer: ${entry.url}`,
		);
		if (entry.style === "links") return "silent";
		result = "linksOnly";
	}
	return result;
}

/**
 * Applies all gates that decide whether a post gets a docs answer.
 * Returns undefined when the post should not be answered.
 * @param {{github: Github, context: Context}} param
 * @returns {Promise<{post: any, isDiscussion: boolean} | undefined>}
 */
async function checkAnswerGates(param) {
	const { context } = param;

	const { post, isDiscussion } = postFromContext(context);
	if (!post) {
		console.log("No issue or discussion in payload, skipping");
		return;
	}

	const author = post.user?.login;
	if (
		!author
		|| excludedUsers.includes(author)
		|| post.user?.type === "Bot"
	) {
		console.log(`Skipping post by ${author}`);
		return;
	}

	if (isDiscussion) {
		const categorySlug = context.payload.discussion.category?.slug;
		if (!QUESTION_CATEGORY_SLUGS.includes(categorySlug)) {
			console.log(`Skipping discussion in category ${categorySlug}`);
			return;
		}
	} else {
		// Device config requests are not questions the docs can answer
		const labels = (post.labels ?? []).map(
			(/** @type {any} */ l) => l.name,
		);
		if (labels.includes("config ⚙")) {
			console.log("Skipping device config request");
			return;
		}
	}

	if (await alreadyAnswered(param, post, isDiscussion)) {
		console.log("Already answered, skipping");
		return;
	}

	return { post, isDiscussion };
}

module.exports = {
	DOCS_ANSWER_COMMENT_TAG,
	alreadyAnswered,
	checkAnswerGates,
	checkSuppression,
};
