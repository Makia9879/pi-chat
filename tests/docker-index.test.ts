import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { executionSystemPrompt } from "../src/execution-prompt.js";

for (const scenario of ["conflict", "image-only", "standalone", "connect"]) {
	test(`Docker extension ${scenario} failure latches tools and user_bash without host fallback`, async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-chat-index-"));
		try {
			const result = await promisify(execFile)(
				process.execPath,
				["--import", "tsx", "tests/docker-index-fixture.ts", scenario],
				{ env: { ...process.env, HOME: home }, timeout: 20000 },
			);
			assert.match(result.stdout, /FAIL_CLOSED_OK/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
}
test("Docker prompt reports actual isolation and read-only root, not Alpine VM", () => {
	const prompt = executionSystemPrompt("Current working directory: /host", "/host", {
		mode: "docker",
		workspacePath: "/workspace",
		sharedPath: "/shared",
	});
	assert.match(prompt, /Docker container/);
	assert.match(prompt, /read-only/);
	assert.doesNotMatch(prompt, /Gondolin VM/);
});
