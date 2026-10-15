// @ts-check

import { describe, expect, it } from "vitest";
import editChangedLogfile from "./editChangedLogfile.cjs";

/**
 * @param {string} link
 * @param {string} [extra]
 */
function body(link, extra = "") {
	return `### Describe the issue\n\nIt broke${extra}\n\n### Upload Logfile\n\n[zwavejs.log](${link})`;
}

/** @param {any} payload */
function check(payload) {
	return editChangedLogfile({ context: /** @type {any} */ ({ payload }) });
}

describe("editChangedLogfile", () => {
	const url = "https://github.com/user-attachments/files/1/zwavejs.log";
	const otherUrl = "https://github.com/user-attachments/files/2/zwavejs.log";

	it("treats new discussions as changed", () => {
		expect(check({ action: "created", discussion: { body: body(url) } }))
			.toBe(true);
	});

	it("ignores edits that leave the logfile alone", () => {
		expect(check({
			action: "edited",
			changes: { body: { from: body(url) } },
			discussion: { body: body(url, " again") },
		})).toBe(false);
	});

	it("ignores edits that do not touch the body", () => {
		expect(check({
			action: "edited",
			changes: { title: { from: "Old title" } },
			discussion: { body: body(url) },
		})).toBe(false);
	});

	it("detects a replaced logfile", () => {
		expect(check({
			action: "edited",
			changes: { body: { from: body(url) } },
			discussion: { body: body(otherUrl) },
		})).toBe(true);
	});

	it("detects a logfile added to a post that had none", () => {
		expect(check({
			action: "edited",
			changes: { body: { from: "### Upload Logfile\n\n_No response_" } },
			discussion: { body: body(url) },
		})).toBe(true);
	});

	it("ignores a removed logfile", () => {
		expect(check({
			action: "edited",
			changes: { body: { from: body(url) } },
			discussion: { body: "### Upload Logfile\n\n_No response_" },
		})).toBe(false);
	});
});
