// @ts-check

// Index loading and embedding-based retrieval for the docs-answer pipeline.

const { loadDocsIndex, retrieve } = require("../indexes/docsIndex.cjs");
const { indexMatchesModel } = require("../indexes/localEmbeddings.cjs");
const { loadPostsIndex } = require("../indexes/postsIndex.cjs");

const MAX_RETRIEVED_CHUNKS = 5;
// Below this best-match cosine similarity the post is off-topic and the
// judge is not invoked. Calibrated for all-MiniLM-L6-v2: on-topic eval
// questions score >= 0.44, unrelated posts stay <= 0.3
const MIN_SIMILARITY = 0.35;

/**
 * Loads the pre-built embeddings indices. Either may be missing,
 * each one enables its part of the comment.
 * @returns {Promise<{docsIndex: any, postsIndex: any}>}
 */
async function loadIndexes() {
	const docsIndexPath = process.env.DOCS_INDEX_PATH;
	let docsIndex = await loadDocsIndex(docsIndexPath);
	if (docsIndex) {
		console.log(
			`Loaded docs index with ${docsIndex.chunks.length} chunks (created ${docsIndex.createdAt})`,
		);
	} else {
		console.log(`No docs index found at ${docsIndexPath}`);
	}

	let postsIndex = await loadPostsIndex(process.env.POSTS_INDEX_PATH);
	if (postsIndex) {
		console.log(
			`Loaded posts index with ${postsIndex.posts.length} posts (created ${postsIndex.createdAt})`,
		);
	} else {
		console.log(
			`No posts index found at ${process.env.POSTS_INDEX_PATH}`,
		);
	}

	// The question is embedded locally. Similarities are only comparable
	// within one model, so indexes built with a different model are skipped
	// until the nightly rebuild replaces them.
	if (docsIndex && !indexMatchesModel(docsIndex, "docs index")) {
		docsIndex = undefined;
	}
	if (postsIndex && !indexMatchesModel(postsIndex, "posts index")) {
		postsIndex = undefined;
	}
	return { docsIndex, postsIndex };
}

/**
 * Retrieves the documentation chunks that might answer the question
 * @param {string} question
 * @param {number[]} questionEmbedding
 * @param {any} index The docs embeddings index
 * @returns {any[] | undefined} Chunks, most relevant first
 */
function retrieveDocsChunks(question, questionEmbedding, index) {
	const { results: ranked, bestSimilarity } = retrieve(
		index,
		questionEmbedding,
		question,
		MAX_RETRIEVED_CHUNKS,
	);

	if (bestSimilarity < MIN_SIMILARITY) {
		console.log(
			`Best similarity ${
				bestSimilarity.toFixed(3)
			} below floor, post is likely off-topic`,
		);
		return;
	}

	console.log(
		"Top matches:",
		ranked.map((r) =>
			`cos=${r.similarity.toFixed(3)} bm25=${
				r.lexical.toFixed(1)
			} ${r.chunk.file}#${r.chunk.anchor}`
		),
	);
	if (ranked.length === 0) {
		console.log("No relevant documentation found");
		return;
	}
	return ranked.map((r) => r.chunk);
}

module.exports = {
	MIN_SIMILARITY,
	loadIndexes,
	retrieveDocsChunks,
};
