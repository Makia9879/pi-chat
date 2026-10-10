import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseChatSendArgs, redactSecrets, sendChatMessage, sendConfiguredChat } from "../src/chat-send.js";
import type { FeishuAccountConfig } from "../src/core/config-types.js";
import { appendConversationRecord, buildBaseRecordFields, readConversationLog } from "../src/log.js";
import { fixture } from "./helpers.js";

const secret = "super-secret-app-value";

function feishuAccount(): FeishuAccountConfig {
	return {
		service: "feishu",
		appId: "cli_a1b2c3d4e5f67890",
		appSecret: secret,
		eventMode: "websocket",
		channels: { room: { id: "oc_room", dm: true } },
	};
}

test("chat-send argument parser accepts flags, quotes, and requires a payload", () => {
	const parsed = parseChatSendArgs("feishu/dm --file /tmp/a.pdf --image=/tmp/b.png 'hello world'");
	assert.equal(parsed.conversation, "feishu/dm");
	assert.deepEqual(parsed.files, ["/tmp/a.pdf"]);
	assert.deepEqual(parsed.images, ["/tmp/b.png"]);
	assert.equal(parsed.text, "hello world");
	assert.throws(() => parseChatSendArgs(""), /Usage/);
	assert.throws(() => parseChatSendArgs("feishu/dm"), /Provide text/);
	assert.throws(() => parseChatSendArgs("feishu/dm --file"), /Missing path/);
	assert.throws(() => parseChatSendArgs('feishu/dm "unterminated'), /Unclosed quote/);
});

test("chat-send rejects an unknown channel before any network call", async () => {
	await assert.rejects(
		() =>
			sendConfiguredChat(
				{ conversation: "missing/nope", text: "hi" },
				{ config: { accounts: { feishu: feishuAccount() } } },
			),
		/Unknown channel: missing\/nope/,
	);
});

test("Feishu chat-send uses REST for text, file, and image and does not lock the channel", async (t) => {
	const f = await fixture({ accounts: { test: feishuAccount() } });
	t.after(f.cleanup);
	const filePath = join(f.root, "a.pdf");
	const imagePath = join(f.root, "b.png");
	await writeFile(filePath, "pdf");
	await writeFile(imagePath, "png");
	const calls: Array<{ url: string; body: string | undefined }> = [];
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const body = init?.body;
		calls.push({
			url,
			body: typeof body === "string" ? body : body instanceof FormData ? "form" : undefined,
		});
		if (url.includes("tenant_access_token")) {
			return Response.json({ code: 0, tenant_access_token: "tenant-token-value", expire: 7200 });
		}
		if (url.includes("/im/v1/files")) return Response.json({ code: 0, data: { file_key: "file_key_1" } });
		if (url.includes("/im/v1/images")) return Response.json({ code: 0, data: { image_key: "img_key_1" } });
		if (url.includes("/im/v1/messages")) {
			const payload = JSON.parse(String(body)) as { msg_type?: string };
			return Response.json({ code: 0, data: { message_id: `om_${payload.msg_type}` } });
		}
		throw new Error(`unexpected ${url}`);
	};
	const result = await sendChatMessage(f.conversation, {
		text: "hello",
		files: [filePath],
		images: [imagePath],
	});
	assert.deepEqual(result.messageIds, ["om_text", "om_file", "om_image"]);
	assert.equal(result.logged, true);
	assert.equal(
		calls.some((call) => call.url.includes("/callback/ws") || call.url.startsWith("wss:")),
		false,
	);
	assert.ok(calls.some((call) => call.url.includes("/im/v1/files")));
	assert.ok(calls.some((call) => call.url.includes("/im/v1/images")));
	assert.equal(calls.filter((call) => call.url.includes("/im/v1/messages")).length, 3);
	await assert.rejects(() => access(f.conversation.lockPath));
	const log = await readConversationLog(f.conversation);
	assert.deepEqual(
		log.map((record) => (record.type === "outbound" ? record.messageId : record.type)),
		["om_text", "om_file", "om_image"],
	);
	assert.equal(
		log.every((record) => record.type === "outbound" && record.jobId === "chat-send"),
		true,
	);
	assert.equal(JSON.stringify(log).includes(secret), false);
	assert.equal(JSON.stringify(log).includes("tenant-token-value"), false);
});

test("chat-send redacts credentials from platform errors", async (t) => {
	const f = await fixture({ accounts: { test: feishuAccount() } });
	t.after(f.cleanup);
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	globalThis.fetch = async () => {
		throw new Error(`auth failed for ${secret} and bot12345:ABCDEF_token`);
	};
	await assert.rejects(
		() => sendChatMessage(f.conversation, { text: "hi" }),
		(error: Error) => {
			assert.match(error.message, /chat-send failed/);
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes("ABCDEF_token"), false);
			assert.match(error.message, /\[redacted\]/);
			return true;
		},
	);
	assert.equal(redactSecrets(`token ${secret}`, [secret]).includes(secret), false);
});

test("Discord and Telegram chat-send use their REST APIs and return message ids", async (t) => {
	const discord = await fixture({
		accounts: {
			test: {
				service: "discord",
				botToken: "discord-token-value",
				applicationId: "app",
				serverId: "guild",
				serverName: "guild",
				channels: { room: { id: "123" } },
			},
		},
	});
	t.after(discord.cleanup);
	const telegram = await fixture({
		accounts: { test: { service: "telegram", botToken: "telegram-token-value", channels: { room: { id: "42" } } } },
	});
	t.after(telegram.cleanup);
	const imagePath = join(discord.root, "pic.png");
	await writeFile(imagePath, "png");
	await writeFile(join(telegram.root, "pic.png"), "png");
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const urls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		urls.push(url);
		if (url.includes("discord.com")) return Response.json({ id: "discord-msg" });
		if (url.includes("sendPhoto")) return Response.json({ ok: true, result: { message_id: 9 } });
		return Response.json({ ok: true, result: { message_id: 8 } });
	};
	const discordResult = await sendChatMessage(discord.conversation, { text: "hi", images: [imagePath] });
	assert.deepEqual(discordResult.messageIds, ["discord-msg", "discord-msg"]);
	assert.ok(urls.some((url) => url.includes("/channels/123/messages")));
	assert.equal(
		urls.some((url) => url.includes("discord-token-value")),
		false,
	);
	const telegramResult = await sendChatMessage(telegram.conversation, {
		text: "hi",
		images: [join(telegram.root, "pic.png")],
	});
	assert.deepEqual(telegramResult.messageIds, ["8", "9"]);
	assert.ok(urls.some((url) => url.includes("/sendPhoto")));
	globalThis.fetch = async () => {
		throw new Error("network down https://api.telegram.org/bottelegram-token-value/sendMessage");
	};
	await assert.rejects(
		() => sendChatMessage(telegram.conversation, { text: "again" }),
		(error: Error) => {
			assert.equal(error.message.includes("telegram-token-value"), false);
			assert.match(error.message, /\[redacted\]/);
			return true;
		},
	);
});

test("concurrent log appends stay valid JSONL with distinct record ids", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await Promise.all(
		[1, 2, 3, 4].map((index) =>
			appendConversationRecord(f.conversation, {
				type: "outbound",
				...buildBaseRecordFields(f.conversation, index),
				messageId: `m${index}`,
				text: `line ${index}`,
				jobId: "chat-send",
			}),
		),
	);
	const log = await readConversationLog(f.conversation);
	assert.equal(log.length, 4);
	const ids = log.map((record) => record.recordId);
	assert.equal(new Set(ids).size, 4);
	assert.deepEqual(
		ids,
		[...ids].sort((left, right) => left - right),
	);
	await assert.rejects(() => access(f.conversation.lockPath));
});
