// @ts-check

// Façade for gh-aw workflows: lazy requires so a single entry point doesn't
// load every module's dependency tree on each invocation
module.exports = {
	prepareDocsAnswer: (...args) =>
		require("./answer/index.cjs").prepareDocsAnswer(...args),
	postDocsAnswer: (...args) =>
		require("./answer/index.cjs").postDocsAnswer(...args),
	classifyLogfile: (...args) =>
		require("./logfile/classifyLogfile.cjs").classifyLogfile(...args),
	classificationToFeedback: (...args) =>
		require("./logfile/classifyLogfile.cjs").classificationToFeedback(
			...args,
		),
	extractLogfile: (...args) =>
		require("./logfile/extract.cjs").extractLogfile(...args),
	extractLogfileInDiscussion: (...args) =>
		require("./logfile/extract.cjs").extractLogfileInDiscussion(...args),
	ensureLogfileFeedback: (...args) =>
		require("./logfile/ensureFeedback.cjs").ensureLogfileFeedback(...args),
	ensureLogfileFeedbackInDiscussion: (...args) =>
		require("./logfile/ensureFeedback.cjs").ensureLogfileFeedbackInDiscussion(
			...args,
		),
	extractLogfileUrlFromDiscussion: (...args) =>
		require("./logfile/extractLogfileUrlFromDiscussion.cjs")(...args),
	postClassifyIssueFeedback: (...args) =>
		require("./classify/post.cjs")(...args),
	updatePostsIndex: (...args) =>
		require("./indexes/updatePostsIndex.cjs")(...args),
	updateEvalTrackingIssue: (...args) =>
		require("./eval/updateEvalTrackingIssue.cjs")(...args),
};
