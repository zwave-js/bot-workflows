// @ts-check

// Single runner for the retrieval-quality evals. Both eval kinds share
// the same wiring - load index, load golden cases, embed the questions,
// score hits, report - and only differ in how the index is loaded and
// how a single case is retrieved and matched. The kind-specific parts
// live in the pipeline specs below.
//
// Usage: node runEval.cjs <docsAnswers|relatedPosts> <index-file>

const fs = require("node:fs/promises");
const path = require("node:path");
const { config } = require("../config.cjs");
const { loadDocsIndex, retrieve } = require("../indexes/docsIndex.cjs");
const { rankRelatedPosts } = require("../indexes/postsIndex.cjs");
const { embed, indexMatchesModel } = require("../indexes/localEmbeddings.cjs");
const { logCase, reportResults } = require("./evalUtils.cjs");

const NUM_RESULTS = 5;

/**
 * @typedef {object} EvalPipeline
 * @property {string} indexName Label used in model-mismatch errors
 * @property {number} defaultMinHitRate
 * @property {string} casesFile Case file path relative to the consumer repo
 * @property {(indexFile: string) => Promise<any>} loadIndex Resolves to undefined when the index is invalid
 * @property {(index: any, cases: any[]) => any[]} filterCases
 * @property {(index: any, embedding: number[], testCase: any) => {hit: boolean, result: import("./evalUtils.cjs").EvalResult}} evaluateCase
 */

/** @type {Record<string, EvalPipeline>} */
const PIPELINES = {
	docsAnswers: {
		indexName: "docs index",
		// Allow a small number of misses before failing, retrieval is not exact
		defaultMinHitRate: 0.9,
		casesFile: config.evalCases.docsAnswersFile,
		loadIndex: (indexFile) => loadDocsIndex(indexFile),
		filterCases: (_index, cases) => cases,
		evaluateCase(index, embedding, { question, expectedFiles }) {
			const { results } = retrieve(
				index,
				embedding,
				question,
				NUM_RESULTS,
			);
			const retrievedFiles = results.map((r) => r.chunk.file);
			return {
				hit: expectedFiles.some((/** @type {string} */ f) =>
					retrievedFiles.includes(f)
				),
				result: {
					title: question.split("\n")[0],
					expected: expectedFiles,
					retrieved: retrievedFiles,
				},
			};
		},
	},
	relatedPosts: {
		indexName: "posts index",
		defaultMinHitRate: 0.8,
		casesFile: config.evalCases.relatedPostsFile,
		loadIndex: async (indexFile) =>
			JSON.parse(await fs.readFile(indexFile, "utf8")),
		filterCases(index, allCases) {
			// Expected posts can leave the index (closed issues age out after
			// a year), which is not a retrieval regression. Skip those cases.
			const inIndex = (
				/** @type {{type: string, number: number}} */ p,
			) => index.posts.some(
				(/** @type {any} */ ip) =>
					ip.type === p.type && ip.number === p.number,
			);
			return allCases.filter((c) => {
				if (c.expectedPosts.some(inIndex)) return true;
				console.log(
					`⏭️ ${
						c.question.split("\n")[0]
					} - no expected post in the index anymore, skipping`,
				);
				return false;
			});
		},
		evaluateCase(index, embedding, { question, expectedPosts }) {
			const results = rankRelatedPosts(
				index,
				embedding,
				// Eval questions are not posts themselves, exclude nothing
				{ type: "", number: 0 },
				{ minSimilarity: 0, maxResults: NUM_RESULTS },
			);
			return {
				hit: expectedPosts.some(
					(/** @type {{type: string, number: number}} */ e) =>
						results.some(
							({ post }) =>
								post.type === e.type
								&& post.number === e.number,
						),
				),
				result: {
					title: question.split("\n")[0],
					expected: expectedPosts.map(
						(/** @type {{type: string, number: number}} */ e) =>
							`${e.type} #${e.number}`,
					),
					retrieved: results.map(
						({ post, similarity }) =>
							`${post.type} #${post.number} (cos=${
								similarity.toFixed(3)
							})`,
					),
				},
			};
		},
	},
};

/**
 * @param {{kind: "docsAnswers" | "relatedPosts", indexFile: string}} param
 */
async function runEval({ kind, indexFile }) {
	const pipeline = PIPELINES[kind];
	if (!pipeline) {
		throw new Error(`Unknown eval kind "${kind}"`);
	}
	const minHitRate = Number(
		process.env.MIN_HIT_RATE || String(pipeline.defaultMinHitRate),
	);

	const index = await pipeline.loadIndex(indexFile);
	if (!index) {
		console.error(
			`No valid ${pipeline.indexName} found at ${indexFile} (missing, wrong version, or malformed)`,
		);
		process.exit(1);
	}
	if (!indexMatchesModel(index, pipeline.indexName)) process.exit(1);

	// Case files live in the consumer repo, config paths are relative to
	// its checkout
	const casesPath = path.join(
		process.env.GITHUB_WORKSPACE || process.cwd(),
		pipeline.casesFile,
	);
	/** @type {any[]} */
	const allCases = JSON.parse(await fs.readFile(casesPath, "utf8"));
	const cases = pipeline.filterCases(index, allCases);

	// Fail loudly instead of silently "passing" an empty eval
	if (cases.length === 0) {
		throw new Error(
			`No eval cases found in ${pipeline.casesFile} - cannot evaluate retrieval quality`,
		);
	}

	const embeddings = await embed(cases.map((c) => c.question));

	/** @type {import("./evalUtils.cjs").EvalResult[]} */
	const failures = [];
	for (let i = 0; i < cases.length; i++) {
		const { hit, result } = pipeline.evaluateCase(
			index,
			embeddings[i],
			cases[i],
		);
		logCase(hit, result);
		if (!hit) failures.push(result);
	}

	await reportResults(NUM_RESULTS, cases.length, failures, minHitRate);
}

if (require.main === module) {
	const [kind, indexFile] = process.argv.slice(2);
	if (!kind || !indexFile) {
		console.error(
			"Usage: node runEval.cjs <docsAnswers|relatedPosts> <index-file>",
		);
		process.exit(1);
	}
	runEval({ kind: /** @type {any} */ (kind), indexFile }).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}

module.exports = { runEval };
