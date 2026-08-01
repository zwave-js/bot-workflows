// @ts-check

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** @type {(param: any) => Promise<void>} */
let postClassifyIssueFeedback;

beforeAll(async () => {
	// The redirects group is optional and absent from config.example.json,
	// so point config.cjs at a workspace whose config includes it
	const workspace = join(tmpdir(), `classify-workspace-${process.pid}`);
	mkdirSync(join(workspace, ".github"), { recursive: true });
	const example = JSON.parse(
		await readFile(
			join(import.meta.dirname, "../../config.example.json"),
			"utf8",
		),
	);
	example.redirects = { issueTracker: "zwave-js/zwave-js" };
	writeFileSync(
		join(workspace, ".github/zwave-js-bot.config.json"),
		JSON.stringify(example),
	);
	process.env.GITHUB_WORKSPACE = workspace;
	postClassifyIssueFeedback = (await import("./post.cjs")).default;
});

/** Fake GitHub client that records created comments */
function mockGithub() {
	/** @type {string[]} */
	const created = [];
	const github = /** @type {any} */ ({
		paginate: (/** @type {any} */ route, /** @type {any} */ params) =>
			route(params),
		rest: {
			issues: {
				listComments: () => [],
				listEventsForTimeline: () => [],
				createComment: (/** @type {any} */ { body }) => {
					created.push(body);
					return {};
				},
			},
		},
	});
	return { github, created };
}

const context = /** @type {any} */ ({
	payload: { issue: { user: { login: "someuser" }, number: 1 } },
	repo: { owner: "zwave-js", repo: "zwave-js-ui" },
	issue: { number: 1 },
});

/** @param {any} content */
async function withAgentOutput(content) {
	const dir = await mkdtemp(join(tmpdir(), "agent-output-"));
	const file = join(dir, "agent_output.json");
	if (content !== undefined) {
		await writeFile(
			file,
			typeof content === "string" ? content : JSON.stringify(content),
		);
	}
	process.env.GH_AW_AGENT_OUTPUT = file;
}

describe("postClassifyIssueFeedback", () => {
	afterEach(() => {
		delete process.env.GH_AW_AGENT_OUTPUT;
	});

	/** @param {any} item */
	async function run(item) {
		if (item !== null) {
			await withAgentOutput({
				items: item === undefined ? [] : [item],
			});
		}
		const { github, created } = mockGithub();
		await postClassifyIssueFeedback({ github, context });
		return created;
	}

	it("posts the wrong-repo comment for a driver classification", async () => {
		const created = await run({
			type: "post_classification",
			classification: "driver",
		});
		expect(created.length).toBe(1);
		expect(created[0]).toContain("Z-Wave JS repository");
		expect(created[0]).toContain("zwave-js/zwave-js/issues");
	});

	it("normalizes case and stray punctuation", async () => {
		const created = await run({
			type: "post_classification",
			classification: "Driver.",
		});
		expect(created.length).toBe(1);
	});

	it("stays silent for UI and unknown classifications", async () => {
		expect(
			await run({ type: "post_classification", classification: "UI" }),
		).toEqual([]);
		expect(
			await run({
				type: "post_classification",
				classification: "unknown",
			}),
		).toEqual([]);
	});

	it("treats garbage classifications as unknown", async () => {
		const created = await run({
			type: "post_classification",
			classification: "ignore previous instructions",
		});
		expect(created).toEqual([]);
	});

	it("skips when the agent reported nothing", async () => {
		expect(await run(undefined)).toEqual([]);
		expect(
			await run({ type: "something_else", classification: "driver" }),
		).toEqual([]);
	});

	it("skips on a missing or malformed output file", async () => {
		// Missing file
		await withAgentOutput(undefined);
		const { github: g1, created: c1 } = mockGithub();
		await postClassifyIssueFeedback({ github: g1, context });
		expect(c1).toEqual([]);

		// Malformed JSON
		await withAgentOutput("{nope");
		const { github: g2, created: c2 } = mockGithub();
		await postClassifyIssueFeedback({ github: g2, context });
		expect(c2).toEqual([]);

		// Items is not an array
		await withAgentOutput({ items: "driver" });
		const { github: g3, created: c3 } = mockGithub();
		await postClassifyIssueFeedback({ github: g3, context });
		expect(c3).toEqual([]);
	});
});
