// @ts-check

/// <reference path="../types.d.ts" />

// Posts the answer comment: composition + posting for both pipeline halves,
// and the judge-verdict-gated safe-output entry point.

const fs = require("node:fs/promises");
const { readAgentOutputItem } = require("./agentOutput.cjs");
const { DOCS_ANSWER_COMMENT_TAG, alreadyAnswered } = require("./gate.cjs");
const {
	parseRelatedExcerpts,
	renderDocsSection,
	validateJudgeResponse,
} = require("./render.cjs");
const { postFromContext } = require("../lib/comments.cjs");

const DOCS_ANSWER_METADATA_TAG = "DOCS_ANSWER_METADATA";
const DOCS_ANSWER_METADATA_VERSION = 1;

/**
 * Composes the answer comment from its sections and posts it
 * @param {{github: Github, context: Context}} param
 * @param {any} post
 * @param {boolean} isDiscussion
 * @param {{text: string, style: "answer" | "links", confidence: number, sections: string[]} | undefined} docsSection
 * @param {string | undefined} postsSection
 */
async function composeAndPostAnswer(
	{ github, context },
	post,
	isDiscussion,
	docsSection,
	postsSection,
) {
	let body = `**Beep, boop! 🤖**

`;
	if (docsSection) {
		body +=
			`_I've tried to answer your question based on the documentation. If this doesn't help, please wait for a human to show up._

${docsSection.text}`;
		if (postsSection) {
			body += `

---

${postsSection}`;
		}
	} else {
		body +=
			`_I've found existing posts that look similar to yours. If they don't help, please wait for a human to show up._

${postsSection}`;
	}

	// Metadata for collectDocsFeedback.cjs to attribute
	// reactions to doc sections without re-parsing the comment
	const metadata = {
		v: DOCS_ANSWER_METADATA_VERSION,
		style: docsSection?.style ?? "posts",
		confidence: docsSection?.confidence ?? null,
		sections: docsSection?.sections ?? [],
		// Traces a posted comment back to the workflow run that judged it
		run: Number(process.env.GITHUB_RUN_ID) || null,
	};

	body += `

---

_${
		docsSection
			? "This answer was"
			: "These suggestions were"
	} generated automatically${
		docsSection ? " based on the documentation" : ""
	}. AI can make mistakes, always check important info._
_Was this helpful? React with 👍 or 👎 to let us know._
${DOCS_ANSWER_COMMENT_TAG}
<!-- ${DOCS_ANSWER_METADATA_TAG} ${JSON.stringify(metadata)} -->`;

	if (isDiscussion) {
		await github.graphql(
			`
			mutation addDiscussionComment($discussionId: ID!, $body: String!) {
				addDiscussionComment(input: {discussionId: $discussionId, body: $body}) {
					comment { id }
				}
			}
			`,
			{ discussionId: post.node_id, body },
		);
	} else {
		await github.rest.issues.createComment({
			...context.repo,
			issue_number: post.number,
			body,
		});
	}
	console.log("Posted docs answer comment");
}

/**
 * Posts the answer comment based on the agentic judge's verdict.
 * Runs as a custom safe-output job after the judge.
 *
 * Expects the following environment variables:
 * - GH_AW_AGENT_OUTPUT: path to the agent output file containing the verdict
 * - DOCS_HANDOFF_PATH: path to the handoff file written by prepareDocsAnswer
 *
 * @param {{github: Github, context: Context}} param
 */
async function postDocsAnswer(param) {
	const { post, isDiscussion } = postFromContext(param.context);
	if (!post) {
		console.log("No issue or discussion in payload, skipping");
		return;
	}

	// The handoff crosses a job boundary as an artifact, so treat its
	// content as data, not trusted structure.
	/** @type {any} */
	let handoff;
	try {
		handoff = JSON.parse(
			await fs.readFile(
				/** @type {string} */ (process.env.DOCS_HANDOFF_PATH),
				"utf8",
			),
		);
	} catch (e) {
		console.log(`::warning::Could not read the handoff: ${e.message}`);
		return;
	}
	if (!Array.isArray(handoff?.chunks)) {
		console.log("::warning::Malformed handoff, skipping");
		return;
	}

	const verdict = await readAgentOutputItem("post_docs_answer");
	if (!verdict) {
		console.log(
			"::warning::The judge did not produce a verdict - no comment is posted",
		);
		return;
	}
	console.log("Judge verdict:", JSON.stringify(verdict));

	const result = validateJudgeResponse({
		confidence: Number(verdict.confidence),
		answer: typeof verdict.answer === "string" && verdict.answer.trim()
			? verdict.answer
			: null,
		relatedExcerpts: parseRelatedExcerpts(verdict.related_excerpts),
	});

	const docsSection = renderDocsSection(
		result,
		handoff.chunks,
		handoff.allowAnswer === true,
	);
	const postsSection = typeof handoff.postsSection === "string"
		? handoff.postsSection
		: undefined;
	if (!docsSection && !postsSection) {
		console.log("Nothing to answer or suggest, skipping");
		return;
	}

	// The judge takes a while, re-check to avoid duplicate answers from
	// overlapping runs on edited posts
	if (await alreadyAnswered(param, post, isDiscussion)) {
		console.log("Already answered, skipping");
		return;
	}

	await composeAndPostAnswer(
		param,
		post,
		isDiscussion,
		docsSection,
		postsSection,
	);
}

module.exports = {
	DOCS_ANSWER_METADATA_TAG,
	DOCS_ANSWER_METADATA_VERSION,
	composeAndPostAnswer,
	postDocsAnswer,
};
