// @ts-check

/// <reference path="../types.d.ts" />

const { logfileReference } = require("../lib/logfileText.cjs");

const SECTION_HEADER = "### Upload Logfile";

/**
 * Whether an edited discussion now references a different logfile than before.
 * Anyone can edit their own discussion as often as they like, so re-running
 * the analysis on every edit would let a single account burn through the AI
 * budget. New discussions always count as changed.
 * @param {{context: Context}} param
 * @returns {boolean}
 */
function editChangedLogfile({ context }) {
	const { action, changes, discussion } = context.payload;
	if (action !== "edited") return true;
	// Title-only edits carry no previous body
	const previousBody = changes?.body?.from;
	if (previousBody == undefined) return false;

	const before = logfileReference(previousBody, SECTION_HEADER);
	const after = logfileReference(discussion?.body, SECTION_HEADER);
	return !!after && after !== before;
}

module.exports = editChangedLogfile;
