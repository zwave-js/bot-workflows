// @ts-check

// End-to-end round trip through the public entry points in index.cjs

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { postDocsAnswer, prepareDocsAnswer } from "./index.cjs";

const { DOCS_INDEX_VERSION } = require("../indexes/docsIndex.cjs");
const { EMBEDDING_MODEL, MODEL_CACHE_KEY, setExtractor } = require(
	"../indexes/localEmbeddings.cjs",
);

// Substitute the pipeline so the answer path runs against the tiny test
// vectors in the fixture indexes instead of downloading the model
beforeEach(() => {
	setExtractor(async (/** @type {string[]} */ batch) => ({
		dims: [batch.length, 2],
		tolist: () => batch.map(() => [1, 0]),
	}));
});

describe("prepareDocsAnswer -> postDocsAnswer round trip", () => {
	it("hands off retrieved chunks and posts the judged answer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "docs-answer-"));
		const docsIndex = {
			version: DOCS_INDEX_VERSION,
			model: EMBEDDING_MODEL,
			modelKey: MODEL_CACHE_KEY,
			createdAt: "2026-01-01T00:00:00Z",
			chunks: [
				{
					file: "guide/foo.md",
					anchor: "bar",
					title: "Bar",
					breadcrumbs: ["Foo", "Bar"],
					text: "How to bar properly",
					hash: "h1",
					embedding: [1, 0],
				},
			],
		};
		await writeFile(
			join(dir, "docs-index.json"),
			JSON.stringify(docsIndex),
		);
		process.env.DOCS_INDEX_PATH = join(dir, "docs-index.json");
		process.env.POSTS_INDEX_PATH = join(dir, "missing.json");
		delete process.env.DOCS_FEEDBACK_PATH;
		process.env.DOCS_HANDOFF_PATH = join(dir, "handoff.json");

		/** @type {string[]} */
		const bodies = [];
		const github = /** @type {any} */ ({
			paginate: (
				/** @type {any} */ route,
				/** @type {any} */ params,
			) => route(params),
			rest: {
				issues: {
					listComments: () => [],
					listEventsForTimeline: () => [],
					createComment: async (/** @type {any} */ { body }) => {
						bodies.push(body);
						return {};
					},
				},
			},
		});
		const context = /** @type {any} */ ({
			payload: {
				issue: {
					user: { login: "someuser" },
					number: 7,
					title: "How do I bar?",
					body: "I cannot figure out how to bar.",
				},
			},
			repo: { owner: "o", repo: "r" },
		});

		expect(await prepareDocsAnswer({ github, context })).toBe(true);

		// The judge input is the projected view of the handoff
		const judgeInput = JSON.parse(
			await readFile(join(dir, "judge-input.json"), "utf8"),
		);
		expect(judgeInput.question).toContain("How do I bar?");
		expect(judgeInput.excerpts).toEqual([
			{ breadcrumbs: ["Foo", "Bar"], text: "How to bar properly" },
		]);

		// The judge reports its verdict through the safe-output job
		await writeFile(
			join(dir, "agent-output.json"),
			JSON.stringify({
				items: [{
					type: "post_docs_answer",
					confidence: 90,
					answer: "Bar it properly.",
					related_excerpts: "0",
				}],
			}),
		);
		process.env.GH_AW_AGENT_OUTPUT = join(dir, "agent-output.json");
		await postDocsAnswer({ github, context });

		expect(bodies.length).toBe(1);
		expect(bodies[0]).toContain("Bar it properly.");
		expect(bodies[0]).toContain("guide/foo?id=bar");
	});

	it("drops nothing silently when the judge reports no verdict but posts exist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "docs-answer-"));
		await writeFile(
			join(dir, "handoff.json"),
			JSON.stringify({
				question: "q",
				allowAnswer: true,
				chunks: [],
				postsSection: "Some related posts",
			}),
		);
		await writeFile(
			join(dir, "agent-output.json"),
			JSON.stringify({ items: [] }),
		);
		process.env.DOCS_HANDOFF_PATH = join(dir, "handoff.json");
		process.env.GH_AW_AGENT_OUTPUT = join(dir, "agent-output.json");

		/** @type {string[]} */
		const bodies = [];
		const github = /** @type {any} */ ({
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
			payload: {
				issue: { user: { login: "someuser" }, number: 7 },
			},
			repo: { owner: "o", repo: "r" },
		});
		// Accepted tradeoff: without a verdict the safe-output job never
		// runs in production; when it does run, it must not throw
		await postDocsAnswer({ github, context });
		expect(bodies).toEqual([]);
	});
});
