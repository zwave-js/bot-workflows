// @ts-check

const fs = require("node:fs");

const MS_PER_DAY = 86_400_000;

/**
 * Parseable JSON is not enough: a truncated embeddings response or an
 * interrupted write leaves a file that loads fine and retrieves nothing.
 * @param {any} parsed
 */
function indexHasContent(parsed) {
	const chunks = parsed?.chunks ?? parsed?.posts;
	return Array.isArray(chunks) && chunks.length > 0;
}

/**
 * Reads and validates the restored index file.
 * @param {string} file
 * @returns {boolean}
 */
function readIndexFileIsUsable(file) {
	try {
		return indexHasContent(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return false;
	}
}

/**
 * Accepts only a non-expired artifact of the expected name, built on the
 * default branch of this repository itself. A fork PR can also have
 * head_branch "master", so the repository check is required.
 * @param {any} artifact
 * @param {string} branch
 * @param {string | undefined} artifactName
 */
function isTrustedArtifact(artifact, branch, artifactName) {
	return artifact?.expired === false
		&& artifact?.name === artifactName
		&& artifact?.workflow_run?.head_branch === branch
		&& artifact?.workflow_run?.head_repository_id
			=== artifact?.workflow_run?.repository_id;
}

/**
 * Picks the newest artifact that passes isTrustedArtifact.
 * @param {any[]} artifacts
 * @param {string} branch
 * @param {string | undefined} artifactName
 * @returns {any | undefined}
 */
function selectArtifact(artifacts, branch, artifactName) {
	return artifacts
		.filter((a) => isTrustedArtifact(a, branch, artifactName))
		.sort((a, b) =>
			new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
		)[0];
}

/**
 * Decides whether a restored index is stale. Staleness is what catches a dead
 * nightly while the cache still serves a usable index. Upload time is the
 * signal, not the index's own createdAt: docs-embeddings skips the rebuild on a
 * cache hit, so unchanged content is still healthy - the nightly re-uploads
 * either way.
 * The status distinguishes an outage the API confirmed ('stale') from one it
 * could not confirm ('unknown'). The artifact listings intermittently omit
 * recent runs, so a stale or missing result only counts as 'stale' once
 * repeated listings agreed on it.
 * @param {{artifactCreated?: string, confirmed: boolean, maxAgeDays: number, now?: number}} param
 * @returns {{status: "fresh" | "stale" | "unknown", ageDays: string, warning?: string}}
 */
function computeStaleness({ artifactCreated, confirmed, maxAgeDays, now }) {
	const nowMs = now ?? Date.now();
	const unconfirmed =
		"the artifact listings failed or disagreed, so the publication state is unknown";
	if (artifactCreated) {
		const createdMs = new Date(artifactCreated).getTime();
		if (Number.isNaN(createdMs)) {
			return {
				status: confirmed ? "stale" : "unknown",
				ageDays: "",
				warning:
					`Unreadable upload timestamp for the index artifact ('${artifactCreated}')`,
			};
		}
		const ageDays = Math.floor((nowMs - createdMs) / MS_PER_DAY);
		if (ageDays < maxAgeDays) {
			return { status: "fresh", ageDays: String(ageDays) };
		}
		if (!confirmed) {
			return {
				status: "unknown",
				ageDays: String(ageDays),
				warning:
					`The newest index artifact found is ${ageDays} day(s) old, but ${unconfirmed}`,
			};
		}
		return {
			status: "stale",
			ageDays: String(ageDays),
			warning:
				`The newest index artifact is ${ageDays} day(s) old (limit ${maxAgeDays}) - the nightly rebuild may be failing`,
		};
	}
	if (confirmed) {
		// Only reachable on a cache hit, since a miss with no artifact cannot
		// produce an index at all
		return {
			status: "stale",
			ageDays: "",
			warning:
				"No unexpired index artifact exists - serving a cached index off a pipeline that has published nothing",
		};
	}
	return {
		status: "unknown",
		ageDays: "",
		warning: `No index artifact found, but ${unconfirmed}`,
	};
}

/**
 * github-script step: reports whether the cache restore yielded a usable index.
 * @param {{core: any}} param
 */
function checkCachedIndex({ core }) {
	const file = process.env.INDEX_FILE;
	const ok = !!file && readIndexFileIsUsable(file);
	core.setOutput("ok", ok ? "true" : "false");
	console.log(
		ok
			? `Cache hit: ${file}`
			: `Cache did not yield a usable ${file}`,
	);
}

// How many recent producer runs to scan for a usable artifact before giving
// up: the newest run all but always still holds it, the rest cover retention
// gaps without an unbounded walk
const MAX_PRODUCER_RUNS = 10;

// Delay before each cross-check attempt. The runs listing intermittently omits
// recent runs or their artifacts, so a single answer does not prove an outage.
const CROSS_CHECK_DELAYS_MS = [0, 5_000, 15_000];

// A missing or stale result counts as confirmed once this many cross-check
// attempts answered with the same runs and artifacts. The other attempts may
// differ.
const MIN_AGREEING_ATTEMPTS = 2;

// Each repo-wide artifact costs one extra request to verify its producing run
const MAX_VERIFIED_ARTIFACTS = 5;

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {any} responseOrError
 * @returns {string}
 */
function requestIdOf(responseOrError) {
	return responseOrError?.headers?.["x-github-request-id"]
		?? responseOrError?.response?.headers?.["x-github-request-id"]
		?? "unknown";
}

/** @param {any} error */
function describeError(error) {
	const status = error?.status ? `HTTP ${error.status}: ` : "";
	return `${status}${error?.message ?? error} [request ${
		requestIdOf(error)
	}]`;
}

/**
 * @param {string} created
 * @param {number} maxAgeDays
 * @param {number} now
 */
function isFresh(created, maxAgeDays, now) {
	const createdMs = new Date(created).getTime();
	return !Number.isNaN(createdMs)
		&& Math.floor((now - createdMs) / MS_PER_DAY) < maxAgeDays;
}

/**
 * @typedef {{runId: number, artifactId: number, created: string}} Candidate
 */

/**
 * @param {Candidate | undefined} a
 * @param {Candidate | undefined} b
 * @returns {Candidate | undefined}
 */
function newerCandidate(a, b) {
	if (!a) return b;
	if (!b) return a;
	return new Date(b.created).getTime() > new Date(a.created).getTime()
		? b
		: a;
}

/**
 * Lists successful producer runs on the default branch, newest first. A fork
 * run never satisfies both branch and success here.
 * @param {{github: any, owner: string, repo: string, producerWorkflow: string, branch: string, created?: string}} param
 * @returns {Promise<any[]>}
 */
async function listProducerRuns(
	{ github, owner, repo, producerWorkflow, branch, created },
) {
	const response = await github.rest.actions.listWorkflowRuns({
		owner,
		repo,
		workflow_id: producerWorkflow,
		branch,
		status: "success",
		per_page: MAX_PRODUCER_RUNS,
		...(created && { created }),
	});
	const runs = response.data?.workflow_runs ?? [];
	console.log(
		`Listed ${runs.length} successful ${producerWorkflow} run(s) on ${branch}${
			created ? ` created ${created}` : ""
		}: ${
			runs.map((r) => `${r.id} (${r.created_at})`).join(", ") || "none"
		} [request ${requestIdOf(response)}]`,
	);
	return runs;
}

/**
 * Returns the trusted artifact of the newest run that has one.
 * @param {{github: any, owner: string, repo: string, runs: any[], branch: string, name: string | undefined}} param
 * @returns {Promise<Candidate | undefined>}
 */
async function firstUsableArtifact({ github, owner, repo, runs, branch, name }) {
	for (const run of runs) {
		const artifacts = await github.paginate(
			github.rest.actions.listWorkflowRunArtifacts,
			{ owner, repo, run_id: run.id, per_page: 100 },
			(/** @type {any} */ response) => {
				console.log(
					`  Run ${run.id}: listed ${response.data.length} artifact(s) [request ${
						requestIdOf(response)
					}]`,
				);
				return response.data;
			},
		);
		const artifact = selectArtifact(artifacts, branch, name);
		console.log(
			`  Run ${run.id}: ${
				artifact
					? `artifact ${artifact.id} uploaded ${artifact.created_at}`
					: "no usable artifact"
			}`,
		);
		if (artifact) {
			return {
				runId: artifact.workflow_run?.id ?? run.id,
				artifactId: artifact.id,
				created: artifact.created_at ?? "",
			};
		}
	}
}

/**
 * One cross-check attempt against two listings: the producer's runs created
 * since `since`, and the repo-wide artifacts of this name. Repo-wide artifacts
 * carry no workflow, so each one is verified against its run before use.
 * @param {{github: any, owner: string, repo: string, producerWorkflow: string, producerId: number, branch: string, name: string, since: string}} param
 * @returns {Promise<{best: Candidate | undefined, signature: string}>}
 */
async function crossCheck(
	{ github, owner, repo, producerWorkflow, producerId, branch, name, since },
) {
	const sinceMs = new Date(since).getTime();
	const runs = await listProducerRuns({
		github,
		owner,
		repo,
		producerWorkflow,
		branch,
		created: `>=${since}`,
	});
	let best = await firstUsableArtifact({
		github,
		owner,
		repo,
		runs,
		branch,
		name,
	});

	const listing = await github.rest.actions.listArtifactsForRepo({
		owner,
		repo,
		name,
		per_page: 100,
	});
	const recent = (listing.data?.artifacts ?? [])
		.filter((a) =>
			isTrustedArtifact(a, branch, name)
			&& new Date(a.created_at).getTime() >= sinceMs
		)
		.sort((a, b) =>
			new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
		)
		.slice(0, MAX_VERIFIED_ARTIFACTS);
	console.log(
		`Repo-wide listing has ${recent.length} recent trusted ${name} artifact(s): ${
			recent.map((a) => `${a.id} from run ${a.workflow_run.id} (${a.created_at})`)
				.join(", ") || "none"
		} [request ${requestIdOf(listing)}]`,
	);

	const verified = [];
	for (const artifact of recent) {
		const response = await github.rest.actions.getWorkflowRun({
			owner,
			repo,
			run_id: artifact.workflow_run.id,
		});
		const run = response.data;
		const trusted = run?.workflow_id === producerId
			&& run?.conclusion === "success"
			&& run?.head_branch === branch
			&& run?.head_repository?.id === run?.repository?.id;
		console.log(
			`  Run ${artifact.workflow_run.id}: ${
				trusted
					? "verified"
					: `rejected (workflow ${run?.workflow_id}, conclusion ${run?.conclusion}, branch ${run?.head_branch})`
			} [request ${requestIdOf(response)}]`,
		);
		if (!trusted) continue;
		verified.push(artifact.id);
		best = newerCandidate(best, {
			runId: artifact.workflow_run.id,
			artifactId: artifact.id,
			created: artifact.created_at,
		});
		// Listed newest first, so the first verified artifact is the newest
		break;
	}

	const signature = JSON.stringify({
		runs: runs.map((r) => r.id).sort(),
		artifacts: verified,
		best: best?.artifactId ?? null,
	});
	return { best, signature };
}

/**
 * github-script step: finds the newest usable index artifact. Pinned to the
 * workflow file that produces it, so no other workflow with actions:write can
 * publish an artifact of the same name that the bot would then load. When the
 * first listing yields nothing fresh, repeated cross-checks decide whether the
 * pipeline really stopped publishing. The `confirmed` output is "true" only
 * when the result is fresh or the cross-checks agreed. A lookup failure
 * degrades to "no index" for the caller to handle via continue-on-error. It
 * must not take down a job triggered by someone opening an issue.
 * @param {{github: any, context: any, core: any, sleep?: (ms: number) => Promise<unknown>, now?: number}} param
 */
async function findIndexArtifact(
	{ github, context, core, sleep = defaultSleep, now = Date.now() },
) {
	const { owner, repo } = context.repo;
	const name = /** @type {string} */ (process.env.ARTIFACT);
	const producerWorkflow = process.env.PRODUCER_WORKFLOW;
	const maxAgeDays = Number(process.env.MAX_AGE_DAYS);
	if (!producerWorkflow) {
		core.setFailed(
			"PRODUCER_WORKFLOW is not set - refusing to select an artifact",
		);
		return;
	}
	if (!(maxAgeDays > 0)) {
		core.setFailed(
			`MAX_AGE_DAYS must be a positive number, got '${process.env.MAX_AGE_DAYS}'`,
		);
		return;
	}

	// The payload's repository object carries the default branch on the events
	// that trigger us; the repos API covers payloads without it. github.ref_name
	// is only usually the default branch, so it stays out of this trust boundary.
	let branch = context.payload?.repository?.default_branch;
	if (!branch) {
		const { data: repoData } = await github.rest.repos.get({ owner, repo });
		branch = repoData.default_branch;
	}
	if (!branch) {
		core.setFailed(
			"Could not resolve the default branch - refusing to select an artifact",
		);
		return;
	}

	/** @type {Candidate | undefined} */
	let best;
	try {
		const runs = await listProducerRuns({
			github,
			owner,
			repo,
			producerWorkflow,
			branch,
		});
		best = await firstUsableArtifact({
			github,
			owner,
			repo,
			runs,
			branch,
			name,
		});
	} catch (error) {
		core.warning(`Listing ${producerWorkflow} runs failed: ${describeError(error)}`);
	}

	let confirmed = true;
	if (!best || !isFresh(best.created, maxAgeDays, now)) {
		console.log(
			best
				? `Newest artifact from the first listing was uploaded ${best.created} - cross-checking`
				: "The first listing found no usable artifact - cross-checking",
		);
		const since = new Date(now - (maxAgeDays + 1) * MS_PER_DAY)
			.toISOString()
			.replace(/\.\d{3}Z$/, "Z");
		/** @type {number | undefined} */
		let producerId;
		const signatures = [];
		for (const [attempt, delay] of CROSS_CHECK_DELAYS_MS.entries()) {
			if (delay) await sleep(delay);
			try {
				if (producerId === undefined) {
					const response = await github.rest.actions.getWorkflow({
						owner,
						repo,
						workflow_id: producerWorkflow,
					});
					producerId = response.data.id;
					console.log(
						`${producerWorkflow} has workflow ID ${producerId} [request ${
							requestIdOf(response)
						}]`,
					);
				}
				const result = await crossCheck({
					github,
					owner,
					repo,
					producerWorkflow,
					producerId: /** @type {number} */ (producerId),
					branch,
					name,
					since,
				});
				best = newerCandidate(best, result.best);
				if (best && isFresh(best.created, maxAgeDays, now)) break;
				signatures.push(result.signature);
			} catch (error) {
				core.warning(
					`Cross-check attempt ${attempt + 1} failed: ${describeError(error)}`,
				);
			}
		}

		const fresh = !!best && isFresh(best.created, maxAgeDays, now);
		/** @type {Map<string, number>} */
		const counts = new Map();
		for (const s of signatures) counts.set(s, (counts.get(s) ?? 0) + 1);
		const agreed = [...counts.values()].some((n) =>
			n >= MIN_AGREEING_ATTEMPTS
		);
		confirmed = fresh || agreed;
		if (!confirmed) {
			console.log(
				`Could not confirm the publication state: ${signatures.length} of ${CROSS_CHECK_DELAYS_MS.length} cross-check attempt(s) answered, ${
					new Set(signatures).size
				} distinct answer(s)`,
			);
		}
	}

	core.setOutput("confirmed", String(confirmed));
	if (!best) {
		console.log(
			`No unexpired ${name} artifact from ${producerWorkflow} on ${branch}`,
		);
		return;
	}
	console.log(
		`Newest usable ${name} artifact is ${best.artifactId} from run ${best.runId}, uploaded ${
			best.created || "unknown"
		}`,
	);
	core.setOutput("id", String(best.runId));
	core.setOutput("created", String(best.created));
}

/**
 * github-script step: reports what was restored and whether the pipeline
 * behind it looks alive.
 * @param {{core: any}} param
 */
function reportRestore({ core }) {
	const file = /** @type {string} */ (process.env.INDEX_FILE);
	const artifact = process.env.ARTIFACT;
	const fromCache = process.env.FROM_CACHE === "true";
	const artifactRun = process.env.ARTIFACT_RUN;
	const artifactCreated = process.env.ARTIFACT_CREATED || undefined;
	const confirmed = process.env.CONFIRMED === "true";
	const lookup = process.env.LOOKUP || "skipped";
	const download = process.env.DOWNLOAD || "skipped";
	const maxAgeDays = Number(process.env.MAX_AGE_DAYS);

	if (!readIndexFileIsUsable(file)) {
		core.setOutput("found", "false");
		core.setOutput("status", "");
		core.setOutput("source", "none");
		core.setOutput("age-days", "");
		// Name the leg that failed - an expired artifact and a misconfigured
		// lookup look identical from the outside otherwise
		core.warning(
			`No ${file} (cache: miss, artifact lookup: ${lookup}, download: ${download}, run: ${
				artifactRun || "none"
			})`,
		);
		return;
	}

	core.setOutput("found", "true");
	core.setOutput("source", fromCache ? "cache" : "artifact");
	console.log(
		fromCache
			? `Using ${file} from the Actions cache`
			: `Using ${file} from the ${artifact} artifact of run ${artifactRun}`,
	);

	const { status, ageDays, warning } = computeStaleness({
		artifactCreated,
		confirmed,
		maxAgeDays,
	});
	if (artifactCreated && ageDays !== "") {
		console.log(
			`Newest ${artifact} artifact uploaded ${artifactCreated} (${ageDays} day(s) ago)`,
		);
	}
	if (warning) core.warning(warning);

	core.setOutput("status", status);
	core.setOutput("age-days", ageDays);
}

module.exports = {
	indexHasContent,
	selectArtifact,
	computeStaleness,
	checkCachedIndex,
	findIndexArtifact,
	reportRestore,
};
