// Comment tags for bot analysis comments
const AUTO_ANALYSIS_COMMENT_TAG = "<!-- AUTO_ANALYSIS_COMMENT_TAG -->";
const AUTO_ANALYSIS_START_TAG = "<!-- AUTO_ANALYSIS_START_TAG -->";
const AUTO_ANALYSIS_END_TAG = "<!-- AUTO_ANALYSIS_END_TAG -->";

/**
 * Check if a PR was modified after a specific comment using the timeline API.
 * This is more robust than timestamp comparisons because it uses GitHub's
 * authoritative event ordering.
 *
 * @param {Github} github
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} commentId - The ID of the comment that triggered the workflow
 * @returns {Promise<boolean>} - True if the PR was modified after the comment
 */
async function wasPRModifiedAfterComment(
	github,
	owner,
	repo,
	prNumber,
	commentId,
) {
	// Fetch all timeline events for the PR
	const events = await github.paginate(
		github.rest.issues.listEventsForTimeline,
		{
			owner,
			repo,
			issue_number: prNumber,
			per_page: 100,
		},
	);

	// Events that indicate the PR code was modified
	const modificationEvents = [
		"head_ref_force_pushed",
		"committed",
		"base_ref_changed",
	];

	// Find our triggering comment in the timeline
	const commentIndex = events.findIndex(
		(e) => e.event === "commented" && e.id === commentId,
	);

	if (commentIndex === -1) {
		throw new Error(
			`Could not find comment ${commentId} in PR timeline - aborting...`,
		);
	}

	const commentEvent = events[commentIndex];
	if (!("created_at" in commentEvent)) {
		throw new Error(
			`Comment ${commentId} has no created_at timestamp - aborting...`,
		);
	}
	const commentTime = new Date(commentEvent.created_at);

	// Check 1: Are there any modification events AFTER our comment in the timeline?
	for (let i = commentIndex + 1; i < events.length; i++) {
		if (modificationEvents.includes(events[i].event)) {
			return true;
		}
	}

	// Check 2: Are there any modification events with created_at >= comment time?
	// This is a backup check in case the timeline ordering is not reliable
	for (const event of events) {
		if (
			modificationEvents.includes(event.event)
			&& "created_at" in event
		) {
			const eventTime = new Date(event.created_at);
			if (eventTime >= commentTime) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Returns when an issue was last transferred into this repository,
 * or 0 if it was created here.
 * @param {{event?: string, created_at?: string}[]} events - Timeline events
 * @returns {number} Epoch milliseconds
 */
function lastTransferTime(events) {
	let transferredAt = 0;
	for (const event of events) {
		if (event.event !== "transferred" || !event.created_at) continue;
		// Issues may be transferred repeatedly, only the last hop matters
		transferredAt = Math.max(
			transferredAt,
			new Date(event.created_at).getTime(),
		);
	}
	return transferredAt;
}

/**
 * Lists an issue's comments, ignoring those inherited from another repository.
 * Transferring an issue recreates the source repo's comments here with their
 * original creation date, so everything older than the last transfer was
 * written elsewhere.
 *
 * @param {Github} github
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 */
async function listCommentsSinceTransfer(github, owner, repo, issueNumber) {
	const comments = await github.paginate(github.rest.issues.listComments, {
		owner,
		repo,
		issue_number: issueNumber,
		per_page: 100,
	});
	// Without comments there is nothing to filter, save the timeline request
	if (comments.length === 0) return comments;

	const events = await github.paginate(
		github.rest.issues.listEventsForTimeline,
		{
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100,
		},
	);
	const transferredAt = lastTransferTime(events);
	if (!transferredAt) return comments;

	return comments.filter(
		(c) => new Date(c.created_at).getTime() > transferredAt,
	);
}

/**
 * Extracts the triggering post from the event payload
 * @param {Context} context
 * @returns {{post: any, isDiscussion: boolean}}
 */
function postFromContext(context) {
	const isDiscussion = !!context.payload.discussion;
	const post = context.payload.discussion ?? context.payload.issue;
	return { post, isDiscussion };
}

module.exports = {
	wasPRModifiedAfterComment,
	lastTransferTime,
	listCommentsSinceTransfer,
	postFromContext,
	AUTO_ANALYSIS_COMMENT_TAG,
	AUTO_ANALYSIS_START_TAG,
	AUTO_ANALYSIS_END_TAG,
};
