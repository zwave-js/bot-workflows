// @ts-check

import { describe, expect, it } from "vitest";

import {
	POSTS_MIN_SIMILARITY,
	balanceCodeFences,
	buildRelatedPostsSection,
	parseRelatedExcerpts,
	renderDocsSection,
	validateJudgeResponse,
} from "./render.cjs";

describe("answer/render", () => {
	describe("validateJudgeResponse", () => {
		it("accepts a well-formed response", () => {
			expect(
				validateJudgeResponse({
					confidence: 82,
					answer: "You can do X by running Y.",
					relatedExcerpts: [0, 2],
				}),
			).toEqual({
				confidence: 82,
				answer: "You can do X by running Y.",
				relatedExcerpts: [0, 2],
			});
		});

		it("degrades to a safe no-answer for a non-object response", () => {
			for (const bad of [null, undefined, "not json", 42, []]) {
				expect(validateJudgeResponse(bad)).toEqual({
					confidence: 0,
					answer: null,
					relatedExcerpts: [],
				});
			}
		});

		it("degrades to a safe no-answer for a non-finite/out-of-range confidence", () => {
			for (
				const bad of [-1, 101, NaN, Infinity, "80", null, undefined]
			) {
				expect(
					validateJudgeResponse({
						confidence: bad,
						answer: "text",
						relatedExcerpts: [],
					}),
				).toEqual({ confidence: 0, answer: null, relatedExcerpts: [] });
			}
		});

		it("accepts confidence at the 0 and 100 boundaries", () => {
			expect(
				validateJudgeResponse({
					confidence: 0,
					answer: null,
					relatedExcerpts: [],
				}).confidence,
			).toBe(0);
			expect(
				validateJudgeResponse({
					confidence: 100,
					answer: "text",
					relatedExcerpts: [],
				}).confidence,
			).toBe(100);
		});

		it("nulls out a non-string answer instead of throwing", () => {
			expect(
				validateJudgeResponse({
					confidence: 90,
					answer: 12345,
					relatedExcerpts: [],
				}).answer,
			).toBeNull();
		});

		it("filters relatedExcerpts down to non-negative integers, dropping the rest", () => {
			expect(
				validateJudgeResponse({
					confidence: 50,
					answer: null,
					relatedExcerpts: [0, 1.5, -1, "2", 3, null],
				}).relatedExcerpts,
			).toEqual([0, 3]);
		});

		it("defaults relatedExcerpts to an empty array when not an array", () => {
			expect(
				validateJudgeResponse({
					confidence: 50,
					answer: null,
					relatedExcerpts: "not an array",
				}).relatedExcerpts,
			).toEqual([]);
		});

		it("closes a fence left open by the length cap", () => {
			const answer = "text\n```js\n" + "x".repeat(20000);
			const { answer: truncated } = validateJudgeResponse({
				confidence: 80,
				answer,
				relatedExcerpts: [],
			});
			// The slice lands inside the code block; a closing fence is appended
			// so the trailing doc-links list is not swallowed
			const fences = truncated.match(/^[ \t]*(?:`{3,}|~{3,})/gm);
			expect(fences).toHaveLength(2);
			expect(truncated.endsWith("```")).toBe(true);
		});

		it("leaves a balanced answer untouched", () => {
			expect(balanceCodeFences("no fences here")).toBe("no fences here");
			expect(balanceCodeFences("```\ncode\n```")).toBe("```\ncode\n```");
		});
	});

	describe("parseRelatedExcerpts", () => {
		it("extracts ids across mixed separators", () => {
			expect(parseRelatedExcerpts("2, 0")).toEqual([2, 0]);
			expect(parseRelatedExcerpts("1;2")).toEqual([1, 2]);
			expect(parseRelatedExcerpts("0")).toEqual([0]);
			expect(parseRelatedExcerpts("")).toEqual([]);
			expect(parseRelatedExcerpts(undefined)).toEqual([]);
		});
	});

	describe("buildRelatedPostsSection", () => {
		/** @param {number} similarity Desired cosine against [1, 0] */
		const post = (similarity, number) => ({
			type: "issue",
			number,
			title: `Post ${number}`,
			url: `https://example.com/${number}`,
			state: "open",
			// Unit vector at the desired cosine to the unit question vector
			embedding: [
				similarity,
				Math.sqrt(1 - similarity ** 2),
			],
		});
		const self = { type: "discussion", number: 999 };

		it("suggests posts at the similarity floor", () => {
			const index = { posts: [post(POSTS_MIN_SIMILARITY, 1)] };
			const section = buildRelatedPostsSection(index, [1, 0], self);
			expect(section).toContain("Post 1");
		});

		it("stays silent below the similarity floor", () => {
			const index = { posts: [post(POSTS_MIN_SIMILARITY - 0.01, 1)] };
			expect(
				buildRelatedPostsSection(index, [1, 0], self),
			).toBeUndefined();
		});
	});

	describe("renderDocsSection", () => {
		const chunks = [
			{
				file: "guide/foo.md",
				anchor: "bar",
				title: "Bar",
				breadcrumbs: ["Foo", "Bar"],
				text: "How to bar",
			},
			{
				file: "guide/foo.md",
				anchor: "baz",
				title: "Baz",
				breadcrumbs: ["Foo", "Bar", "Baz"],
				text: "How to baz",
			},
		];

		it("renders a full answer at high confidence", () => {
			const section = renderDocsSection(
				{
					confidence: 80,
					answer: "Do the thing.",
					relatedExcerpts: [0],
				},
				chunks,
				true,
			);
			expect(section?.style).toBe("answer");
			expect(section?.text).toContain("Do the thing.");
			expect(section?.text).toContain("guide/foo?id=bar");
			expect(section?.sections).toEqual(["guide/foo.md#bar"]);
		});

		it("degrades to links between the thresholds", () => {
			const section = renderDocsSection(
				{
					confidence: 50,
					answer: "Do the thing.",
					relatedExcerpts: [0],
				},
				chunks,
				true,
			);
			expect(section?.style).toBe("links");
			expect(section?.text).not.toContain("Do the thing.");
		});

		it("degrades to links when answers are suppressed", () => {
			const section = renderDocsSection(
				{
					confidence: 95,
					answer: "Do the thing.",
					relatedExcerpts: [0],
				},
				chunks,
				false,
			);
			expect(section?.style).toBe("links");
		});

		it("renders nothing below the link threshold or without excerpts", () => {
			expect(
				renderDocsSection(
					{ confidence: 30, answer: null, relatedExcerpts: [0] },
					chunks,
					true,
				),
			).toBeUndefined();
			expect(
				renderDocsSection(
					{ confidence: 80, answer: null, relatedExcerpts: [] },
					chunks,
					true,
				),
			).toBeUndefined();
		});

		it("does not link a subsection next to its ancestor", () => {
			const section = renderDocsSection(
				{ confidence: 50, answer: null, relatedExcerpts: [1, 0] },
				chunks,
				true,
			);
			expect(section?.sections).toEqual(["guide/foo.md#bar"]);
		});
	});
});
