// @ts-check

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeStaleness,
	findIndexArtifact,
	indexHasContent,
	selectArtifact,
} from "./restoreBotIndex.cjs";

describe("restoreBotIndex", () => {
	describe("indexHasContent", () => {
		it("accepts a docs index with chunks", () => {
			expect(indexHasContent({ chunks: [{}] })).toBe(true);
		});

		it("accepts a posts index with posts", () => {
			expect(indexHasContent({ posts: [{}, {}] })).toBe(true);
		});

		it("rejects an empty or missing collection", () => {
			expect(indexHasContent({ chunks: [] })).toBe(false);
			expect(indexHasContent({ posts: [] })).toBe(false);
			expect(indexHasContent({})).toBe(false);
			expect(indexHasContent(null)).toBe(false);
			expect(indexHasContent(undefined)).toBe(false);
		});

		it("rejects a non-array collection", () => {
			expect(indexHasContent({ chunks: "nope" })).toBe(false);
		});
	});

	describe("selectArtifact", () => {
		const NAME = "docs-index";
		const onBranch = (overrides = {}) => ({
			expired: false,
			name: NAME,
			created_at: "2026-01-01T00:00:00Z",
			workflow_run: {
				id: 1,
				head_branch: "master",
				head_repository_id: 42,
				repository_id: 42,
			},
			...overrides,
		});

		it("returns undefined when nothing qualifies", () => {
			expect(selectArtifact([], "master", NAME)).toBeUndefined();
		});

		it("skips expired artifacts", () => {
			expect(
				selectArtifact([onBranch({ expired: true })], "master", NAME),
			)
				.toBeUndefined();
		});

		it("skips a foreign-named artifact from the same run", () => {
			const foreign = onBranch({ name: "some-other-artifact" });
			expect(selectArtifact([foreign], "master", NAME)).toBeUndefined();
		});

		it("skips artifacts from another branch", () => {
			const fork = onBranch({
				workflow_run: {
					id: 2,
					head_branch: "master",
					head_repository_id: 99,
					repository_id: 42,
				},
			});
			expect(selectArtifact([fork], "master", NAME)).toBeUndefined();
		});

		it("skips artifacts not built on the default branch", () => {
			const feature = onBranch({
				workflow_run: {
					id: 3,
					head_branch: "feature",
					head_repository_id: 42,
					repository_id: 42,
				},
			});
			expect(selectArtifact([feature], "master", NAME)).toBeUndefined();
		});

		it("picks the newest qualifying artifact", () => {
			const older = onBranch({ created_at: "2026-01-01T00:00:00Z" });
			const newer = onBranch({
				created_at: "2026-02-01T00:00:00Z",
				workflow_run: {
					id: 7,
					head_branch: "master",
					head_repository_id: 42,
					repository_id: 42,
				},
			});
			expect(
				selectArtifact([older, newer], "master", NAME).workflow_run.id,
			).toBe(7);
		});
	});

	describe("computeStaleness", () => {
		const now = Date.UTC(2026, 0, 10);

		it("is fresh when the newest artifact is within the limit", () => {
			const r = computeStaleness({
				artifactCreated: "2026-01-09T00:00:00Z",
				confirmed: true,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("fresh");
			expect(r.ageDays).toBe("1");
			expect(r.warning).toBeUndefined();
		});

		it("is stale and warns when the artifact is at or over the limit", () => {
			const r = computeStaleness({
				artifactCreated: "2026-01-05T00:00:00Z",
				confirmed: true,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("stale");
			expect(r.ageDays).toBe("5");
			expect(r.warning).toMatch(/nightly rebuild may be failing/);
		});

		it("is unknown on an unreadable timestamp without confirmation", () => {
			const r = computeStaleness({
				artifactCreated: "not a date",
				confirmed: false,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("unknown");
		});

		it("is stale on an unreadable timestamp", () => {
			const r = computeStaleness({
				artifactCreated: "not a date",
				confirmed: true,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("stale");
			expect(r.ageDays).toBe("");
			expect(r.warning).toMatch(/Unreadable upload timestamp/);
		});

		it("is stale when the API answered with no artifact", () => {
			const r = computeStaleness({
				confirmed: true,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("stale");
			expect(r.warning).toMatch(/published nothing/);
		});

		it("reports unknown when no artifact was found without confirmation", () => {
			const r = computeStaleness({
				confirmed: false,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("unknown");
			expect(r.warning).toMatch(/publication state is unknown/);
		});

		it("reports unknown for an old artifact without confirmation", () => {
			const r = computeStaleness({
				artifactCreated: "2026-01-01T00:00:00Z",
				confirmed: false,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("unknown");
			expect(r.ageDays).toBe("9");
		});

		it("stays fresh without confirmation", () => {
			const r = computeStaleness({
				artifactCreated: "2026-01-09T00:00:00Z",
				confirmed: false,
				maxAgeDays: 3,
				now,
			});
			expect(r.status).toBe("fresh");
		});
	});

	describe("findIndexArtifact", () => {
		const NOW = Date.UTC(2026, 8, 29, 12);
		const PRODUCER_ID = 555;
		const daysAgo = (n) =>
			new Date(NOW - n * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
		const run = (id, ageDays, overrides = {}) => ({
			id,
			created_at: daysAgo(ageDays),
			workflow_id: PRODUCER_ID,
			conclusion: "success",
			head_branch: "master",
			head_repository: { id: 42 },
			repository: { id: 42 },
			...overrides,
		});
		const artifact = (id, runId, ageDays, overrides = {}) => ({
			id,
			name: "docs-index",
			expired: false,
			created_at: daysAgo(ageDays),
			workflow_run: {
				id: runId,
				head_branch: "master",
				head_repository_id: 42,
				repository_id: 42,
			},
			...overrides,
		});
		const apiError = (status, requestId) =>
			Object.assign(new Error("Server Error"), {
				status,
				response: { headers: { "x-github-request-id": requestId } },
			});

		// Each list holds one answer per call. The last answer repeats.
		const sequence = (values) => {
			let i = 0;
			return () => values[Math.min(i++, values.length - 1)];
		};

		function fakeGithub({
			primary = [[]],
			timeBounded = [[]],
			runArtifacts = {},
			repoArtifacts = [[]],
			runs = {},
		} = {}) {
			let requests = 0;
			const respond = (value, kind) => {
				if (value instanceof Error) throw value;
				return {
					data: value,
					headers: { "x-github-request-id": `${kind}-${++requests}` },
				};
			};
			const nextPrimary = sequence(primary);
			const nextTimeBounded = sequence(timeBounded);
			const nextRepo = sequence(repoArtifacts);
			/** @type {Record<number, () => any>} */
			const perRun = {};
			const wrap = (value, key) =>
				value instanceof Error ? value : { [key]: value };
			return {
				// Serves one page, shaped like Octokit's normalized response
				paginate: vi.fn(async (method, params, mapFn) => {
					const response = await method(params);
					return mapFn({ ...response, data: response.data.artifacts });
				}),
				rest: {
					repos: { get: vi.fn() },
					actions: {
						listWorkflowRuns: vi.fn(async (params) =>
							respond(
								wrap(
									params.created ? nextTimeBounded() : nextPrimary(),
									"workflow_runs",
								),
								"runs",
							)
						),
						listWorkflowRunArtifacts: vi.fn(async ({ run_id }) => {
							perRun[run_id] ??= sequence(runArtifacts[run_id] ?? [[]]);
							return respond({ artifacts: perRun[run_id]() }, "run-artifacts");
						}),
						listArtifactsForRepo: vi.fn(async () =>
							respond(wrap(nextRepo(), "artifacts"), "repo-artifacts")
						),
						getWorkflowRun: vi.fn(async ({ run_id }) =>
							respond(runs[run_id], "run")
						),
						getWorkflow: vi.fn(async () =>
							respond({ id: PRODUCER_ID }, "workflow")
						),
					},
				},
			};
		}

		const context = {
			repo: { owner: "zwave-js", repo: "zwave-js" },
			payload: { repository: { default_branch: "master" } },
		};

		let env;
		let log;
		beforeEach(() => {
			env = { ...process.env };
			process.env.ARTIFACT = "docs-index";
			process.env.PRODUCER_WORKFLOW = "docs-embeddings.yml";
			process.env.MAX_AGE_DAYS = "3";
			log = vi.spyOn(console, "log").mockImplementation(() => {});
		});
		afterEach(() => {
			process.env = env;
			vi.restoreAllMocks();
		});

		async function find(github) {
			const outputs = {};
			const core = {
				setOutput: vi.fn((k, v) => {
					outputs[k] = v;
				}),
				warning: vi.fn(),
				setFailed: vi.fn(),
			};
			const sleep = vi.fn(async () => {});
			await findIndexArtifact({ github, context, core, sleep, now: NOW });
			return { outputs, core, sleep };
		}

		it("takes a fresh artifact from the first listing without cross-checking", async () => {
			const github = fakeGithub({
				primary: [[run(1, 0)]],
				runArtifacts: { 1: [[artifact(11, 1, 0)]] },
			});
			const { outputs, sleep } = await find(github);
			expect(outputs).toEqual({
				confirmed: "true",
				id: "1",
				created: daysAgo(0),
			});
			expect(github.rest.actions.getWorkflow).not.toHaveBeenCalled();
			expect(sleep).not.toHaveBeenCalled();
		});

		it("recovers an artifact the first listing missed", async () => {
			const github = fakeGithub({
				primary: [[run(1, 0)]],
				timeBounded: [[run(1, 0)]],
				runArtifacts: { 1: [[], [artifact(11, 1, 0)]] },
			});
			const { outputs, sleep } = await find(github);
			expect(outputs.id).toBe("1");
			expect(outputs.confirmed).toBe("true");
			expect(sleep).not.toHaveBeenCalled();
		});

		it("prefers a recent run over an old one from a stale listing", async () => {
			const github = fakeGithub({
				primary: [[run(2, 29)]],
				timeBounded: [[run(3, 1)]],
				runArtifacts: {
					2: [[artifact(21, 2, 29)]],
					3: [[artifact(31, 3, 1)]],
				},
			});
			const { outputs } = await find(github);
			expect(outputs.id).toBe("3");
			expect(outputs.created).toBe(daysAgo(1));
			expect(outputs.confirmed).toBe("true");
			expect(github.rest.actions.listWorkflowRuns).toHaveBeenLastCalledWith(
				expect.objectContaining({
					workflow_id: "docs-embeddings.yml",
					branch: "master",
					status: "success",
					created: `>=${daysAgo(4)}`,
				}),
			);
		});

		it("retries after an empty cross-check and finds a fresh artifact", async () => {
			const github = fakeGithub({
				timeBounded: [[], [run(3, 1)]],
				runArtifacts: { 3: [[artifact(31, 3, 1)]] },
			});
			const { outputs, sleep } = await find(github);
			expect(outputs.id).toBe("3");
			expect(outputs.confirmed).toBe("true");
			expect(sleep.mock.calls).toEqual([[5_000]]);
		});

		it("finds a fresh artifact through the repo-wide listing", async () => {
			const github = fakeGithub({
				repoArtifacts: [[artifact(41, 4, 0)]],
				runs: { 4: run(4, 0) },
			});
			const { outputs } = await find(github);
			expect(outputs.id).toBe("4");
			expect(outputs.confirmed).toBe("true");
		});

		it("confirms a persistent outage when every attempt agrees on nothing", async () => {
			const github = fakeGithub();
			const { outputs, sleep } = await find(github);
			expect(outputs).toEqual({ confirmed: "true" });
			expect(sleep.mock.calls).toEqual([[5_000], [15_000]]);
			expect(computeStaleness({ confirmed: true, maxAgeDays: 3, now: NOW }).status)
				.toBe("stale");
		});

		it("confirms a stale artifact when every attempt agrees", async () => {
			const github = fakeGithub({
				primary: [[run(2, 10)]],
				runArtifacts: { 2: [[artifact(21, 2, 10)]] },
			});
			const { outputs } = await find(github);
			expect(outputs).toEqual({
				confirmed: "true",
				id: "2",
				created: daysAgo(10),
			});
			expect(
				computeStaleness({
					artifactCreated: outputs.created,
					confirmed: true,
					maxAgeDays: 3,
					now: NOW,
				}).status,
			).toBe("stale");
		});

		it("confirms when two of three attempts agree", async () => {
			const github = fakeGithub({
				timeBounded: [[run(5, 1)], [], [run(5, 1)]],
			});
			const { outputs } = await find(github);
			expect(outputs).toEqual({ confirmed: "true" });
		});

		it("does not confirm when the listings disagree", async () => {
			const github = fakeGithub({
				timeBounded: [[run(5, 1)], [], [run(5, 1), run(6, 0)]],
			});
			const { outputs } = await find(github);
			expect(outputs).toEqual({ confirmed: "false" });
			expect(
				computeStaleness({ confirmed: false, maxAgeDays: 3, now: NOW }).status,
			).toBe("unknown");
		});

		it("does not confirm when every cross-check fails", async () => {
			const github = fakeGithub({
				timeBounded: [apiError(502, "req-502")],
			});
			const { outputs, core } = await find(github);
			expect(outputs).toEqual({ confirmed: "false" });
			expect(core.warning).toHaveBeenCalledTimes(3);
			expect(core.warning).toHaveBeenCalledWith(
				expect.stringMatching(/attempt 1 failed: HTTP 502: .*\[request req-502\]/),
			);
		});

		it("confirms when two attempts agree despite one failure", async () => {
			const github = fakeGithub({
				timeBounded: [apiError(500, "req-500"), []],
			});
			const { outputs } = await find(github);
			expect(outputs).toEqual({ confirmed: "true" });
		});

		it("falls back to the cross-check when the first listing fails", async () => {
			const github = fakeGithub({
				primary: [apiError(503, "req-503")],
				timeBounded: [[run(3, 1)]],
				runArtifacts: { 3: [[artifact(31, 3, 1)]] },
			});
			const { outputs, core } = await find(github);
			expect(outputs.id).toBe("3");
			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("req-503"),
			);
		});

		it("ignores untrusted artifacts from either listing", async () => {
			const fork = { head_branch: "master", head_repository_id: 99, repository_id: 42 };
			const github = fakeGithub({
				timeBounded: [[run(8, 0)]],
				runArtifacts: {
					8: [[
						artifact(81, 8, 0, { workflow_run: { id: 8, ...fork } }),
						artifact(82, 8, 0, { expired: true }),
						artifact(83, 8, 0, { name: "posts-index" }),
					]],
				},
				repoArtifacts: [[
					artifact(71, 7, 0),
					artifact(72, 9, 0),
					artifact(73, 10, 0, { workflow_run: { id: 10, ...fork } }),
				]],
				runs: {
					7: run(7, 0, { workflow_id: 999 }),
					9: run(9, 0, { conclusion: "failure" }),
				},
			});
			const { outputs } = await find(github);
			expect(outputs).toEqual({ confirmed: "true" });
			expect(github.rest.actions.getWorkflowRun).not.toHaveBeenCalledWith(
				expect.objectContaining({ run_id: 10 }),
			);
		});

		it("logs candidate runs, timestamps and request IDs", async () => {
			const github = fakeGithub({
				timeBounded: [[run(3, 1)]],
				runArtifacts: { 3: [[artifact(31, 3, 1)]] },
			});
			await find(github);
			const logged = log.mock.calls.map((c) => c[0]).join("\n");
			expect(logged).toContain(`3 (${daysAgo(1)})`);
			expect(logged).toContain(`artifact 31 uploaded ${daysAgo(1)}`);
			expect(logged).toMatch(/\[request runs-\d+\]/);
			expect(logged).toMatch(/\[request run-artifacts-\d+\]/);
			expect(logged).toMatch(/workflow ID 555 \[request workflow-\d+\]/);
		});

		it("refuses to run without a valid age limit", async () => {
			process.env.MAX_AGE_DAYS = "";
			const { core, outputs } = await find(fakeGithub());
			expect(core.setFailed).toHaveBeenCalled();
			expect(outputs).toEqual({});
		});
	});
});
