// @ts-check

// Evaluates the retrieval quality of the related-posts suggestions
// against a golden set of questions with known related issues/discussions.
// Run daily in CI to catch regressions from changes to the cleaning/
// ranking logic or embedding model.
//
// Usage: node evalRelatedPosts.cjs <index-file>

const { runEval } = require("./runEval.cjs");

if (require.main === module) {
	const [indexFile] = process.argv.slice(2);
	if (!indexFile) {
		console.error("Usage: node evalRelatedPosts.cjs <index-file>");
		process.exit(1);
	}
	runEval({ kind: "relatedPosts", indexFile }).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
