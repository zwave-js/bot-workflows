// @ts-check

/// <reference path="../types.d.ts" />

const { extractLogfileContent } = require("../lib/logfileText.cjs");
const { discussionTarget, issueTarget } = require("./conversationTarget.cjs");

/**
 * Extracts the logfile content from the post's logfile section
 * @param {import("./conversationTarget.cjs").ConversationTarget} target
 */
async function extract(target) {
	const body = target.post.body;

	// Check if this is a bug report which requires a logfile
	if (!body.includes(target.sectionHeader)) return;

	const logfileSection = body.slice(
		body.indexOf(target.sectionHeader) + target.sectionHeader.length,
	);

	const content = await extractLogfileContent(logfileSection);
	if (target.requiresLogfile) {
		// This category requires a logfile, so an empty section is an error
		return content ?? "MISSING_LOGFILE";
	}
	return content;
}

/**
 * Original entry point for issues
 * @param {{github: Github, context: Context}} param
 */
async function extractLogfile(param) {
	return extract(issueTarget(param));
}

/**
 * Original entry point for discussions
 * @param {{github: Github, context: Context}} param
 */
async function extractLogfileInDiscussion(param) {
	const target = discussionTarget(param);
	if (!target) return;

	const categorySlug = target.post.category.slug;
	console.log("categorySlug:", categorySlug);

	// Only check for logfiles in categories that require one
	if (categorySlug !== "request-support-investigate-issue") return;

	console.log(
		"sectionHeader found:",
		target.post.body.includes(target.sectionHeader),
	);

	try {
		return await extract(target);
	} catch (error) {
		console.error("Error extracting logfile:", error);
		return null;
	}
}

module.exports = {
	extractLogfile,
	extractLogfileInDiscussion,
};
