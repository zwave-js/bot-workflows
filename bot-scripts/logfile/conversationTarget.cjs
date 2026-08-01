// @ts-check

/// <reference path="../types.d.ts" />

const { config } = require("../config.cjs");
const { listCommentsSinceTransfer } = require("../lib/comments.cjs");

const LOGFILE_COMMENT_TAG = "<!-- LOGFILE_COMMENT_TAG -->";

/**
 * @typedef {object} ConversationTarget
 * @property {any} post The triggering issue or discussion payload
 * @property {string} sectionHeader Form section that contains the logfile
 * @property {boolean} requiresLogfile Whether an empty section is an error
 * @property {() => Promise<{id: string | number, authorLogin: string | undefined, body: string | undefined}[]>} listComments
 * @property {(id: string | number, body: string) => Promise<void>} updateComment
 * @property {(body: string) => Promise<void>} createComment
 * @property {(id: string | number) => Promise<void>} clearComment Removes or neutralizes an obsolete feedback comment
 */

/**
 * @param {{github: Github, context: Context}} param
 * @returns {ConversationTarget}
 */
function issueTarget({ github, context }) {
	const options = {
		owner: context.repo.owner,
		repo: context.repo.repo,
	};

	return {
		post: context.payload.issue,
		sectionHeader: "### Attach Driver Logfile",
		requiresLogfile: false,

		async listComments() {
			const comments = await listCommentsSinceTransfer(
				github,
				options.owner,
				options.repo,
				context.issue.number,
			);
			return comments.map((c) => ({
				id: c.id,
				authorLogin: c.user?.login,
				body: c.body,
			}));
		},

		async updateComment(id, body) {
			await github.rest.issues.updateComment({
				...options,
				comment_id: /** @type {number} */ (id),
				body,
			});
		},

		async createComment(body) {
			await github.rest.issues.createComment({
				...options,
				issue_number: context.issue.number,
				body,
			});
		},

		async clearComment(id) {
			await github.rest.issues.deleteComment({
				...options,
				comment_id: /** @type {number} */ (id),
			});
		},
	};
}

/**
 * @param {{github: Github, context: Context}} param
 * @returns {ConversationTarget | undefined} undefined when the payload has no discussion
 */
function discussionTarget({ github, context }) {
	const discussion = context.payload.discussion;
	if (!discussion) return undefined;

	const queryComments = /* GraphQL */ `
		query Discussion($owner: String!, $repo: String!, $number: Int!) {
			repository(owner: $owner, name: $repo) {
				discussion(number: $number) {
					comments(first: 100) {
						nodes {
							id
							author {
								login
							}
							body
						}
					}
				}
			}
		}
	`;
	const updateCommentQuery = /* GraphQL */ `
		mutation updateComment($commentId: ID!, $body: String!) {
			updateDiscussionComment(input: {commentId: $commentId, body: $body}) {
				comment {
					id
				}
			}
		}
	`;
	const addCommentQuery = /* GraphQL */ `
		mutation reply($discussionId: ID!, $body: String!) {
			addDiscussionComment(input: {discussionId: $discussionId, body: $body}) {
				comment {
					id
				}
			}
		}
	`;

	return {
		post: discussion,
		sectionHeader: "### Upload Logfile",
		requiresLogfile: true,

		async listComments() {
			const queryResult = await github.graphql(queryComments, {
				owner: context.repo.owner,
				repo: context.repo.repo,
				number: discussion.number,
			});
			const comments = queryResult.repository.discussion.comments.nodes;
			return comments.map((c) => ({
				id: c.id,
				authorLogin: c.author.login,
				body: c.body,
			}));
		},

		async updateComment(id, body) {
			await github.graphql(updateCommentQuery, {
				commentId: id,
				body,
			});
		},

		async createComment(body) {
			await github.graphql(addCommentQuery, {
				discussionId: discussion.node_id,
				body,
			});
		},

		async clearComment(id) {
			// Discussion comments cannot be deleted via GraphQL by the bot,
			// so replace the feedback with an all-clear instead
			await this.updateComment(
				id,
				"All good now, thanks!" + LOGFILE_COMMENT_TAG,
			);
		},
	};
}

/**
 * Finds an existing feedback comment from the bot
 * @param {ConversationTarget} target
 */
async function findExistingFeedbackComment(target) {
	const comments = await target.listComments();
	return comments.find(
		(c) =>
			c.authorLogin === config.bot.login
			&& c.body?.includes(LOGFILE_COMMENT_TAG),
	);
}

module.exports = {
	LOGFILE_COMMENT_TAG,
	issueTarget,
	discussionTarget,
	findExistingFeedbackComment,
};
