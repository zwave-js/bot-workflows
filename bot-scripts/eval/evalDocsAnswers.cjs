// @ts-check

// Evaluates the retrieval quality of the docs answer bot against a
// golden set of questions with known relevant documentation files.
// Run daily in CI to catch regressions from docs restructuring or
// changes to the chunking/retrieval logic.
//
// Usage: node evalDocsAnswers.cjs <index-file>

const { runEval } = require("./runEval.cjs");

if (require.main === module) {
	const [indexFile] = process.argv.slice(2);
	if (!indexFile) {
		console.error("Usage: node evalDocsAnswers.cjs <index-file>");
		process.exit(1);
	}
	runEval({ kind: "docsAnswers", indexFile }).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
