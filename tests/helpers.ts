import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConversation } from "../src/config.js";
import type { ChatConfig } from "../src/core/config-types.js";

export function config(): ChatConfig {
	return { accounts: { test: { service: "telegram", botToken: "test", channels: { room: { id: "1" } } } } };
}

export async function fixture(input = config()) {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-test-"));
	const conversation = resolveConversation(input, "test/room");
	if (!conversation) throw new Error("Missing fixture conversation");
	Object.assign(conversation, {
		accountDir: root,
		sharedDir: join(root, "shared"),
		conversationDir: join(root, "channel"),
		workspaceDir: join(root, "work"),
		gondolinDir: join(root, "vm"),
		dockerDir: join(root, "docker"),
		accountMemoryPath: join(root, "shared", "memory.md"),
		channelMemoryPath: join(root, "work", "memory.md"),
		logPath: join(root, "channel", "channel.jsonl"),
		filesDir: join(root, "work", "incoming"),
		lockPath: join(root, "channel", ".lock"),
	});
	if (conversation.runtimeMode === "local") {
		conversation.workspacePath = conversation.workspaceDir;
		conversation.sharedPath = conversation.sharedDir;
	}
	return { conversation, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
