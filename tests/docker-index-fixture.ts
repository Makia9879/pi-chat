import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import extension from "../index.js";

const scenario = process.argv[2];
const events = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
let active: string[] = [];
const flags: Record<string, unknown> =
	scenario === "conflict"
		? { "chat-docker": true, "chat-local": true }
		: scenario === "image-only"
			? { "chat-docker-image": "bad" }
			: scenario === "connect"
				? { "chat-conversation": "test/room" }
				: { "chat-docker": true };
const api = {
	registerFlag() {},
	registerCommand() {},
	registerMessageRenderer() {},
	getFlag(name: string) {
		return flags[name];
	},
	on(name: string, handler: (...args: unknown[]) => Promise<unknown>) {
		events.set(name, handler);
	},
	registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
		tools.set(tool.name, tool);
	},
	setActiveTools(names: string[]) {
		active = names;
	},
	appendEntry() {},
	getThinkingLevel() {
		return "off";
	},
};
const ctx = {
	cwd: homedir(),
	ui: { setStatus() {}, notify() {} },
	sessionManager: {
		getEntries() {
			return [{ type: "custom", customType: "pi-chat-state", data: { conversationId: "must/not-connect" } }];
		},
	},
};
const directory = join(homedir(), ".pi", "agent", "chat");
await mkdir(directory, { recursive: true });
await writeFile(
	join(directory, "config.json"),
	JSON.stringify({
		accounts: {
			test: { service: "telegram", botToken: "fake", channels: { room: { id: "1", runtime: { mode: "docker" } } } },
		},
	}),
);
extension(api as unknown as ExtensionAPI);
const start = events.get("session_start");
const toolCall = events.get("tool_call");
const userBash = events.get("user_bash");
assert.ok(start && toolCall && userBash);
await assert.rejects(start({}, ctx as unknown as ExtensionContext));
assert.ok(active.includes("read"));
for (const name of ["read", "write", "edit", "bash"]) {
	const tool = tools.get(name);
	assert.ok(tool);
	await assert.rejects(tool.execute("id", {}, undefined, undefined, ctx));
}
const blocked = await toolCall({ toolName: "unsafe-host-tool" });
assert.deepEqual((blocked as { block: boolean }).block, true);
await assert.rejects(userBash({ command: "touch /tmp/SHOULD_NOT_RUN" }));
console.log("FAIL_CLOSED_OK");
