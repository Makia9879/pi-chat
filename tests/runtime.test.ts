import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	listConfiguredConversations,
	resolveConversation,
	resolveFeishuEventMode,
	validateWorkerConversations,
	workspaceConflictWarnings,
	writePrivateConfigFile,
} from "../src/config.js";
import { displayPath } from "../src/execution.js";
import { executionSystemPrompt } from "../src/execution-prompt.js";
import { ConversationRuntime } from "../src/runtime.js";
import { config, fixture } from "./helpers.js";

test("configuration preserves legacy VM defaults and merges runtime settings by scope", () => {
	const cfg = config();
	const legacy = resolveConversation(cfg, "test/room");
	assert.equal(legacy?.runtimeMode, "gondolin");
	assert.equal(legacy?.workspacePath, "/workspace");
	assert.ok(legacy?.workspaceDir.endsWith("/channels/room/workspace"));
	cfg.runtime = { mode: "local" };
	assert.equal(resolveConversation(cfg, "test/room")?.workspaceDir, "/workspace");
	cfg.accounts.test.runtime = { mode: undefined, workspaceDir: "/tmp/account" };
	cfg.accounts.test.channels.room.runtime = { workspaceDir: "/tmp/channel/" };
	const local = resolveConversation(cfg, "test/room");
	assert.equal(local?.runtimeMode, "local");
	assert.equal(local?.workspacePath, "/tmp/channel");
	assert.equal(local?.channelMemoryPath, "/tmp/channel/memory.md");
	assert.equal(local?.filesDir, "/tmp/channel/incoming");
	cfg.accounts.test.channels.room.runtime = { mode: "gondolin" };
	assert.equal(resolveConversation(cfg, "test/room")?.workspacePath, "/workspace");
	assert.equal(resolveConversation(cfg, "test/room")?.workspaceDir, "/tmp/account");
	cfg.runtime.mode = "invalid" as "local";
	cfg.accounts.test.channels.room.runtime = {};
	assert.throws(() => resolveConversation(cfg, "test/room"), /Unknown runtime/);
	cfg.runtime = { workspaceDir: "relative" };
	cfg.accounts.test.runtime = {};
	assert.throws(() => resolveConversation(cfg, "test/room"), /absolute/);
});

test("workspace prompt supports legacy pi text, current XML and custom system prompts", () => {
	const backend = { workspacePath: "/workspace", sharedPath: "/tmp/shared", mode: "local" as const };
	assert.ok(
		executionSystemPrompt("Current working directory: /tmp/original", "/tmp/original", backend).startsWith(
			"Current working directory: /workspace",
		),
	);
	assert.ok(
		executionSystemPrompt("<cwd>\n/tmp/original\n</cwd>", "/tmp/original", backend).startsWith(
			"<cwd>\n/workspace\n</cwd>",
		),
	);
	assert.match(
		executionSystemPrompt("Custom prompt", "/tmp/original", backend),
		/NOT sandboxed.*Working directory: \/workspace/,
	);
});

test("worker preflight rejects Feishu callback conflicts but leaves existing services alone", () => {
	const cfg = config();
	assert.doesNotThrow(() => validateWorkerConversations(listConfiguredConversations(cfg)));
	cfg.accounts.feishu = {
		service: "feishu",
		appId: "app",
		appSecret: "secret",
		verificationToken: "token",
		channels: { one: { id: "oc_1" }, two: { id: "oc_2" } },
	};
	assert.throws(() => validateWorkerConversations(listConfiguredConversations(cfg)), /one channel per app/);
	delete cfg.accounts.feishu.channels.two;
	cfg.accounts.other = { ...cfg.accounts.feishu, appId: "other" };
	assert.throws(() => validateWorkerConversations(listConfiguredConversations(cfg)), /distinct webhook ports/);
	cfg.accounts.other.webhook = { port: 3001 };
	assert.doesNotThrow(() => validateWorkerConversations(listConfiguredConversations(cfg)));
	cfg.accounts.ws = {
		service: "feishu",
		appId: "ws-app",
		appSecret: "secret",
		eventMode: "websocket",
		channels: { one: { id: "oc_ws" } },
	};
	cfg.accounts.ws2 = {
		service: "feishu",
		appId: "ws-app-2",
		appSecret: "secret",
		eventMode: "websocket",
		channels: { one: { id: "oc_ws2" } },
	};
	assert.doesNotThrow(() => validateWorkerConversations(listConfiguredConversations(cfg)));
	cfg.accounts.ws2.appId = "ws-app";
	assert.throws(() => validateWorkerConversations(listConfiguredConversations(cfg)), /one channel per app/);
	cfg.accounts.ws2.appId = "ws-app-2";
	cfg.accounts.ws2.eventMode = "callback" as "websocket";
	assert.throws(() => validateWorkerConversations(listConfiguredConversations(cfg)), /Unknown Feishu event mode/);
	cfg.runtime = { mode: "local", workspaceDir: "/workspace" };
	cfg.accounts.shared = {
		service: "telegram",
		botToken: "t",
		channels: { room: { id: "9" } },
	};
	assert.match(workspaceConflictWarnings(listConfiguredConversations(cfg)).join("\n"), /\/workspace is shared by:/);
});

test("Feishu eventMode is websocket only when set; omitted configs stay on HTTP", () => {
	assert.equal(resolveFeishuEventMode({}), "http");
	assert.equal(resolveFeishuEventMode({ eventMode: "http" }), "http");
	assert.equal(resolveFeishuEventMode({ eventMode: "websocket" }), "websocket");
	assert.throws(() => resolveFeishuEventMode({ eventMode: "callback" }), /Unknown Feishu event mode/);
});

test("config rewrite enforces private permissions on an existing file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-config-"));
	try {
		const path = join(root, "config.json");
		await writeFile(path, "{}\n", { mode: 0o644 });
		await writePrivateConfigFile(path, { accounts: {} });
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("catch-up, access checks, failed job boundaries and local attachment paths", async (t) => {
	const cfg = config();
	cfg.runtime = { mode: "local" };
	cfg.accounts.test.access = { allowedUserIds: ["allowed"] };
	const f = await fixture(cfg);
	t.after(f.cleanup);
	const runtime = await ConversationRuntime.connect(f.conversation, `pi-chat-${process.pid}-test`);
	t.after(() => runtime.disconnect());
	const inbound = { userId: "allowed", mentionedBot: true, text: "catch-up" };
	assert.equal((await runtime.ingestInbound(inbound)).jobQueued, false);
	runtime.armAfterCurrentTail();
	assert.equal(runtime.allowsInput({ userId: "allowed", text: "ok" }), true);
	assert.equal(runtime.allowsInput({ userId: "denied", text: "no" }), false);
	assert.equal((await runtime.ingestInbound({ ...inbound, userId: "denied" })).jobQueued, false);
	assert.equal(runtime.parseControlCommand({ ...inbound, userId: "denied", text: "stop" }), undefined);
	assert.deepEqual(runtime.parseControlCommand({ ...inbound, text: "/model" }), { name: "model" });
	assert.deepEqual(runtime.parseControlCommand({ ...inbound, text: "model xai/grok-4.7:high" }), {
		name: "model",
		pattern: "xai/grok-4.7:high",
	});
	assert.equal(runtime.parseControlCommand({ ...inbound, userId: "denied", text: "/model grok" }), undefined);
	await writeFile(join(f.conversation.filesDir, "a.txt"), "hello");
	await runtime.ingestInbound({
		...inbound,
		text: "first",
		attachments: [{ path: join(f.conversation.filesDir, "a.txt") }],
	});
	const first = runtime.beginNextJob();
	assert.ok(first?.prompt.includes(`${f.conversation.workspaceDir}/incoming/a.txt`));
	assert.ok(first?.prompt.includes("[uid:allowed]"));
	await runtime.failActiveJob("test failure");
	await runtime.ingestInbound({ ...inbound, text: "second" });
	assert.ok(runtime.beginNextJob()?.prompt.includes("first"));
	await runtime.completeActiveJob("done");
	await runtime.ingestInbound({ ...inbound, text: "third" });
	assert.ok(!runtime.beginNextJob()?.prompt.includes("second"));
	assert.equal(
		displayPath(f.conversation, f.conversation.channelMemoryPath),
		`${f.conversation.workspaceDir}/memory.md`,
	);
});

test("VM attachment display and Telegram DM triggering remain compatible", async (t) => {
	const cfg = config();
	cfg.accounts.test.channels.room.dm = true;
	const f = await fixture(cfg);
	t.after(f.cleanup);
	const runtime = await ConversationRuntime.connect(f.conversation, `pi-chat-${process.pid}-dm`);
	t.after(() => runtime.disconnect());
	runtime.armAfterCurrentTail();
	assert.equal((await runtime.ingestInbound({ userId: "u", text: "hi", mentionedBot: false })).jobQueued, true);
	assert.equal(displayPath(f.conversation, f.conversation.channelMemoryPath), "/workspace/memory.md");
});
