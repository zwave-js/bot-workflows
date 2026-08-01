// @ts-check

/// <reference path="../types.d.ts" />

const {
	LOGFILE_COMMENT_TAG,
	discussionTarget,
	findExistingFeedbackComment,
	issueTarget,
} = require("./conversationTarget.cjs");

/**
 * @param {string} feedback
 * @param {string} user
 */
function feedbackMessage(feedback, user) {
	switch (feedback) {
		case "OK":
			// No message needed, all is good
			return "";

		case "ERROR_FETCH":
			return `👋 Hey @${user}!

I was not able to download the logfile you provided. Please make sure the link is correct.
`;

		case "ERROR_CODE_BLOCK_TOO_LONG":
			return `👋 Hey @${user}!

It looks like you copied the contents of a logfile. Please attach it as a file instead, so it is easier to work with.
_Note: You can just drag & drop files into the textbox. Just make sure to use a supported file extension like \`.log\` or \`.txt\`_
`;

		case "MISSING_LOGFILE":
			return `👋 Hey @${user}!

It looks like you did not upload a logfile in the "Upload Logfile" section. To help us investigate, please edit your post and attach a [driver log](https://zwave-js.github.io/zwave-js-ui/#/troubleshooting/generating-logs?id=driver-logs) on loglevel "Debug" there.
`;

		case "WRONG_LOG_LEVEL":
			return `👋 Hey @${user}!

It looks like you attached a Z-Wave JS driver log, but with the wrong loglevel. Please make sure to set the loglevel to "Debug" when making a [driver log](https://zwave-js.github.io/zwave-js-ui/#/troubleshooting/generating-logs?id=driver-logs).
`;

		case "Z_UI":
			return `👋 Hey @${user}!

It looks like you attached a Z-Wave JS UI log instead of a [driver log](https://zwave-js.github.io/zwave-js-ui/#/troubleshooting/generating-logs?id=driver-logs). Also remember to set the loglevel to "Debug".
`;

		case "HA_ONLY":
			return `👋 Hey @${user}!

It looks like you attached a Home Assistant log that does not include Z-Wave JS driver logs.

As a reminder, here's how to create the correct logfile:
[Home Assistant Z-Wave Integration](https://www.home-assistant.io/integrations/zwave_js#how-do-i-access-the-z-wave-logs)
`;

		case "BINARY":
			return `👋 Hey @${user}!

It looks like the file you attached is not a text file. Please attach the logfile as a plain text file with a \`.log\` or \`.txt\` extension, or a zip archive containing exactly one such file.
`;

		default:
			return `👋 Hey @${user}!

It looks like you attached a logfile, but it doesn't look like it a **driver log** that came from Z-Wave JS.

Please double-check that you uploaded the correct logfile. If you did, disregard this comment.

As a reminder, here's how to create one:

- [Z-Wave JS  UI](https://zwave-js.github.io/zwave-js-ui/#/troubleshooting/generating-logs?id=driver-logs)
- [Home Assistant Z-Wave Integration](https://www.home-assistant.io/integrations/zwave_js#how-do-i-access-the-z-wave-logs)
- [ioBroker.zwave2 Adapter](https://github.com/AlCalzone/ioBroker.zwave2/blob/master/docs/en/troubleshooting.md#providing-the-necessary-information-for-an-issue)
`;
	}
}

/**
 * Posts, updates or clears the bot's logfile feedback comment
 * @param {import("./conversationTarget.cjs").ConversationTarget} target
 * @param {string} feedback
 */
async function ensureFeedback(target, feedback) {
	const user = target.post.user.login;

	let message = feedbackMessage(feedback, user);
	// Tag the message so it's easier to find the comments later
	if (message) message += LOGFILE_COMMENT_TAG;

	try {
		const existing = await findExistingFeedbackComment(target);
		if (existing) {
			if (message) {
				await target.updateComment(existing.id, message);
			} else {
				// No need to have a comment, all is ok
				await target.clearComment(existing.id);
			}
			return;
		}
	} catch {
		// Ok make a new one maybe
	}

	if (message) {
		await target.createComment(message);
	}
}

/**
 * Original entry point for issues
 * @param {{github: Github, context: Context}} param
 * @param {string} feedback
 */
async function ensureLogfileFeedback(param, feedback) {
	return ensureFeedback(issueTarget(param), feedback);
}

/**
 * Original entry point for discussions
 * @param {{github: Github, context: Context}} param
 * @param {string} feedback
 */
async function ensureLogfileFeedbackInDiscussion(param, feedback) {
	const target = discussionTarget(param);
	if (!target) return;
	return ensureFeedback(target, feedback);
}

module.exports = {
	ensureLogfileFeedback,
	ensureLogfileFeedbackInDiscussion,
};
