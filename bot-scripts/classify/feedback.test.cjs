// @ts-check

import { describe, expect, it } from "vitest";
// The repo-root test config has no redirects group, matching a consumer
// that did not configure a redirect target
import classifyIssueFeedback from "./feedback.cjs";

const context = /** @type {any} */ ({
	payload: { issue: { user: { login: "someuser" }, number: 1 } },
	repo: { owner: "zwave-js", repo: "zwave-js-ui" },
	issue: { number: 1 },
});

describe("classifyIssueFeedback", () => {
	it("skips when config.redirects is not set", async () => {
		/** @type {string[]} */
		const created = [];
		const github = /** @type {any} */ ({
			rest: {
				issues: {
					createComment: (/** @type {any} */ { body }) => {
						created.push(body);
						return {};
					},
				},
			},
		});
		await classifyIssueFeedback({ github, context }, "driver");
		expect(created).toEqual([]);
	});
});
