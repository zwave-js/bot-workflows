// @ts-check

import { describe, expect, it } from "vitest";

import { DOCS_ANSWER_COMMENT_TAG } from "./gate.cjs";
import {
	DOCS_ANSWER_METADATA_TAG,
	composeAndPostAnswer,
} from "./post.cjs";

describe("answer/post", () => {
	describe("composeAndPostAnswer", () => {
		function mockPoster() {
			/** @type {string[]} */
			const bodies = [];
			const github = /** @type {any} */ ({
				graphql: async (
					/** @type {string} */ _q,
					/** @type {any} */ vars,
				) => {
					bodies.push(vars.body);
					return {};
				},
				rest: {
					issues: {
						createComment: async (/** @type {any} */ { body }) => {
							bodies.push(body);
							return {};
						},
					},
				},
			});
			const context = /** @type {any} */ ({
				repo: { owner: "o", repo: "r" },
			});
			return { github, context, bodies };
		}
		const docsSection = {
			text: "The docs part",
			style: /** @type {const} */ ("answer"),
			confidence: 90,
			sections: ["a.md#b"],
		};

		/** @param {string} body */
		function parseMetadata(body) {
			const match = body.match(
				new RegExp(`${DOCS_ANSWER_METADATA_TAG} (.*?) -->`),
			);
			return JSON.parse(/** @type {string} */ (match?.[1]));
		}

		it("composes docs + posts for issues", async () => {
			const { github, context, bodies } = mockPoster();
			await composeAndPostAnswer(
				{ github, context },
				{ number: 1 },
				false,
				docsSection,
				"The posts part",
			);
			expect(bodies[0]).toContain("The docs part");
			expect(bodies[0]).toContain("The posts part");
			expect(bodies[0]).toContain(DOCS_ANSWER_COMMENT_TAG);
			expect(parseMetadata(bodies[0])).toMatchObject({
				style: "answer",
				confidence: 90,
				sections: ["a.md#b"],
			});
		});

		it("composes a docs-only answer", async () => {
			const { github, context, bodies } = mockPoster();
			await composeAndPostAnswer(
				{ github, context },
				{ number: 1 },
				false,
				docsSection,
				undefined,
			);
			expect(bodies[0]).toContain("The docs part");
			expect(bodies[0]).not.toContain("existing posts");
		});

		it("composes a posts-only answer", async () => {
			const { github, context, bodies } = mockPoster();
			await composeAndPostAnswer(
				{ github, context },
				{ number: 1 },
				false,
				undefined,
				"The posts part",
			);
			expect(bodies[0]).toContain("The posts part");
			expect(parseMetadata(bodies[0]).style).toBe("posts");
		});

		it("posts to discussions via GraphQL", async () => {
			const { github, context, bodies } = mockPoster();
			await composeAndPostAnswer(
				{ github, context },
				{ node_id: "D_1" },
				true,
				docsSection,
				undefined,
			);
			expect(bodies.length).toBe(1);
		});
	});
});
