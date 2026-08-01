// @ts-check

import { describe, expect, it } from "vitest";

import {
	DOCS_ANSWER_COMMENT_TAG,
	alreadyAnswered,
	checkAnswerGates,
	checkSuppression,
} from "./gate.cjs";

/**
 * @param {any[]} comments
 * @param {any[]} events
 */
function mockGithub(comments, events) {
	return /** @type {any} */ ({
		paginate: (/** @type {any} */ route, /** @type {any} */ params) =>
			route(params),
		rest: {
			issues: {
				listComments: () => comments,
				listEventsForTimeline: () => events,
			},
		},
	});
}

describe("answer/gate", () => {
	describe("checkSuppression", () => {
		const embeddingModel = "text-embedding-3-small";
		const questionEmbedding = [1, 0, 0];

		it("allows when there is no feedback cache", () => {
			expect(
				checkSuppression(questionEmbedding, undefined, embeddingModel),
			)
				.toBe("allow");
		});

		it("allows when the feedback cache used a different embedding model", () => {
			expect(
				checkSuppression(
					questionEmbedding,
					{ model: "a-different-model", suppressed: [] },
					embeddingModel,
				),
			).toBe("allow");
		});

		it("allows when no suppressed entry is similar enough", () => {
			expect(
				checkSuppression(
					questionEmbedding,
					{
						model: embeddingModel,
						suppressed: [
							{
								embedding: [0, 1, 0],
								style: "answer",
								url: "https://example/1",
							},
						],
					},
					embeddingModel,
				),
			).toBe("allow");
		});

		it("demotes to linksOnly when similar to a downvoted full answer", () => {
			expect(
				checkSuppression(
					questionEmbedding,
					{
						model: embeddingModel,
						suppressed: [
							{
								embedding: [1, 0, 0],
								style: "answer",
								url: "https://example/1",
							},
						],
					},
					embeddingModel,
				),
			).toBe("linksOnly");
		});

		it("silences entirely when similar to a downvoted links-only answer", () => {
			expect(
				checkSuppression(
					questionEmbedding,
					{
						model: embeddingModel,
						suppressed: [
							{
								embedding: [1, 0, 0],
								style: "links",
								url: "https://example/1",
							},
						],
					},
					embeddingModel,
				),
			).toBe("silent");
		});

		it("ignores malformed suppression entries instead of throwing or NaN-passing", () => {
			expect(
				checkSuppression(
					questionEmbedding,
					{
						model: embeddingModel,
						suppressed: [
							{ embedding: "not an array", style: "answer" },
							{ embedding: [1, 0], style: "answer" }, // wrong length
							{ style: "answer" }, // missing embedding
						],
					},
					embeddingModel,
				),
			).toBe("allow");
		});
	});

	describe("alreadyAnswered", () => {
		it("ignores answers inherited from a transferred issue", async () => {
			const events = [{
				event: "transferred",
				created_at: "2026-01-02T00:00:00Z",
			}];
			const inherited = {
				created_at: "2026-01-01T00:00:00Z",
				body: DOCS_ANSWER_COMMENT_TAG,
			};
			const own = {
				created_at: "2026-01-03T00:00:00Z",
				body: DOCS_ANSWER_COMMENT_TAG,
			};
			/** @param {any[]} comments */
			const param = (comments) => ({
				github: mockGithub(comments, events),
				context: /** @type {any} */ ({
					repo: { owner: "zwave-js", repo: "zwave-js" },
				}),
			});

			expect(
				await alreadyAnswered(param([inherited]), { number: 1 }, false),
			).toBe(false);
			expect(
				await alreadyAnswered(
					param([inherited, own]),
					{ number: 1 },
					false,
				),
			).toBe(true);
		});
	});

	describe("checkAnswerGates", () => {
		const github = mockGithub([], []);
		/** @param {any} payload */
		const param = (payload) => ({
			github,
			context: /** @type {any} */ ({
				payload,
				repo: { owner: "o", repo: "r" },
			}),
		});

		it("skips excluded and bot authors", async () => {
			expect(
				await checkAnswerGates(
					param({ issue: { user: { login: "AlCalzone" } } }),
				),
			).toBeUndefined();
			expect(
				await checkAnswerGates(
					param({
						issue: { user: { login: "some[bot]", type: "Bot" } },
					}),
				),
			).toBeUndefined();
		});

		it("skips discussions outside the question categories", async () => {
			expect(
				await checkAnswerGates(
					param({
						discussion: {
							user: { login: "someuser" },
							category: { slug: "ideas" },
						},
					}),
				),
			).toBeUndefined();
		});

		it("passes a fresh community issue through", async () => {
			const result = await checkAnswerGates(
				param({ issue: { user: { login: "someuser" }, number: 5 } }),
			);
			expect(result?.isDiscussion).toBe(false);
			expect(result?.post?.number).toBe(5);
		});
	});
});
