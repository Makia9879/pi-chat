import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { createConversationExecution } from "../src/execution.js";
import { config, fixture } from "./helpers.js";

test("local tools work without loading Gondolin; configured cwd, read/write/edit and attachments", async (t) => {
	const cfg = config();
	cfg.runtime = { mode: "local" };
	const f = await fixture(cfg);
	t.after(f.cleanup);
	const local = await createConversationExecution(f.conversation);
	t.after(() => local.close());
	await local.start();
	assert.equal(local.mode, "local");
	const cwd = f.conversation.workspaceDir;
	await createWriteTool(cwd, { operations: await local.createWriteOperations() }).execute("write", {
		path: "a.txt",
		content: "hello",
	});
	await createEditTool(cwd, { operations: await local.createEditOperations() }).execute("edit", {
		path: "a.txt",
		edits: [{ oldText: "hello", newText: "world" }],
	});
	const read = await createReadTool(cwd, { operations: await local.createReadOperations() }).execute("read", {
		path: "a.txt",
	});
	assert.ok(JSON.stringify(read).includes("world"));
	const result = await createBashTool(cwd, { operations: await local.createBashOperations() }).execute("bash", {
		command: "pwd; printf 'out'; printf 'err' >&2",
	});
	assert.ok(JSON.stringify(result).includes(cwd));
	assert.ok(JSON.stringify(result).includes("out"));
	assert.equal(await readFile(await local.stageAttachment("a.txt"), "utf8"), "world");
	await writeFile(join(f.root, "outside.txt"), "private");
	await symlink(join(f.root, "outside.txt"), join(cwd, "link.txt"));
	await assert.rejects(local.stageAttachment("link.txt"), /inside/);
	await assert.rejects(local.stageAttachment("../outside.txt"), /inside/);
});

test("local bash isolates inherited env, supports cancellation, timeout and shutdown", async (t) => {
	const cfg = config();
	cfg.runtime = { mode: "local" };
	const f = await fixture(cfg);
	t.after(f.cleanup);
	const local = await createConversationExecution(f.conversation);
	t.after(() => local.close());
	await local.start();
	const ops = await local.createBashOperations();
	const cwd = local.workspacePath;
	process.env.PI_CHAT_TEST_SECRET = "must-not-leak";
	t.after(() => {
		delete process.env.PI_CHAT_TEST_SECRET;
	});
	let output = "";
	await ops.exec(`printf "%s" "\${PI_CHAT_TEST_SECRET-unset}"`, cwd, {
		onData: (data) => {
			output += data;
		},
	});
	assert.equal(output, "unset");
	await assert.rejects(ops.exec("sleep 60", cwd, { onData: () => {}, timeout: 0.05 }), /timeout/);
	await assert.rejects(ops.exec("sleep 60", cwd, { onData: () => {}, signal: AbortSignal.abort() }), /aborted/);
	await assert.rejects(ops.exec("sleep 60", cwd, { onData: () => {}, signal: AbortSignal.timeout(50) }), /aborted/);
	const pending = ops.exec("sleep 60", cwd, { onData: () => {} });
	const rejection = assert.rejects(pending, /aborted/);
	await local.close();
	await rejection;
	await assert.rejects(local.start(), /closed/);
});

test("local mode refuses HTTP-hook secrets rather than exposing plaintext env vars", async (t) => {
	const cfg = config();
	cfg.runtime = { mode: "local" };
	cfg.gondolin = { secrets: { TOKEN: { value: "secret", hosts: ["example.com"] } } };
	const f = await fixture(cfg);
	t.after(f.cleanup);
	const local = await createConversationExecution(f.conversation);
	await assert.rejects(local.start(), /cannot be used in local mode/);
	await assert.rejects(local.createBashOperations(), /cannot be used in local mode/);
	await assert.rejects(local.stageAttachment("a.txt"), /cannot be used in local mode/);
});
