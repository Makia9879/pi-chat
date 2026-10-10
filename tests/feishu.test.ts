import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { Domain, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { resolveFeishuEventMode } from "../src/config.js";
import type { FeishuAccountConfig } from "../src/core/config-types.js";
import {
	connectFeishuLive,
	consumeFeishuNonce,
	createFeishuWsClient,
	decodeFeishuEvent,
	type FeishuEvent,
	feishuEventFromSdkData,
	feishuMessageToInput,
	feishuReactionEmojis,
	feishuReactionsEnabled,
	feishuRequestPath,
	feishuSdkDomain,
	isFeishuReplyTargetError,
} from "../src/live/feishu.js";
import { ConversationRuntime } from "../src/runtime.js";
import { FeishuClient } from "../src/services/feishu.js";
import { fixture } from "./helpers.js";

const account: FeishuAccountConfig = {
	service: "feishu",
	appId: "cli_test",
	appSecret: "secret",
	verificationToken: "verify",
	botUserId: "ou_bot",
	channels: { room: { id: "oc_room" } },
};
function event(id = "om_1"): FeishuEvent {
	return {
		header: { app_id: "cli_test", token: "verify", event_type: "im.message.receive_v1", event_id: `ev_${id}` },
		event: {
			sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
			message: {
				chat_id: "oc_room",
				message_id: id,
				message_type: "text",
				content: JSON.stringify({ text: "@_user_1 hello" }),
				mentions: [{ key: "@_user_1", name: "bot", id: { open_id: "ou_bot" } }],
			},
		},
	};
}

function encrypted(payload: unknown, key: string) {
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
	const raw = JSON.stringify({
		encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString("base64"),
	});
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = "nonce";
	return {
		raw,
		headers: {
			"x-lark-request-timestamp": timestamp,
			"x-lark-request-nonce": nonce,
			"x-lark-signature": createHash("sha256")
				.update(timestamp + nonce + key + raw)
				.digest("hex"),
		},
	};
}

test("Feishu callback token, AES decryption, signature, expiry and app identity", () => {
	assert.deepEqual(decodeFeishuEvent(JSON.stringify(event()), {}, account), event());
	assert.throws(
		() => decodeFeishuEvent(JSON.stringify(event()), {}, { ...account, verificationToken: "wrong" }),
		/token/,
	);
	assert.throws(() => decodeFeishuEvent(JSON.stringify(event()), {}, { ...account, appId: "other" }), /App ID/);
	const encAccount = { ...account, encryptKey: "key" };
	const enc = encrypted(event(), "key");
	assert.deepEqual(decodeFeishuEvent(enc.raw, enc.headers, encAccount), event());
	assert.throws(
		() => decodeFeishuEvent(enc.raw, { ...enc.headers, "x-lark-signature": "bad" }, encAccount),
		/signature/,
	);
	assert.throws(
		() => decodeFeishuEvent(enc.raw, { ...enc.headers, "x-lark-request-timestamp": "1" }, encAccount),
		/expired/,
	);
	assert.throws(() => decodeFeishuEvent(enc.raw, {}, account), /Encrypt Key/);
	const challenge = encrypted({ type: "url_verification", token: "verify", challenge: "test" }, "key");
	assert.equal(decodeFeishuEvent(challenge.raw, {}, encAccount).challenge, "test");
	assert.equal(feishuRequestPath("/feishu/events?foo=1"), "/feishu/events");
	const nonces = new Set<string>();
	consumeFeishuNonce(nonces, "1", "n");
	assert.throws(() => consumeFeishuNonce(nonces, "1", "n"), /Replayed/);
	assert.equal(isFeishuReplyTargetError(new Error("Feishu API /im/v1/messages failed (230011): missing")), true);
	assert.equal(isFeishuReplyTargetError(new Error("Feishu API /im/v1/messages failed (99991400): rate")), false);
});

test("Feishu conversion filters channels/self, uses stable open_id and recognizes bot mentions", async (t) => {
	const f = await fixture({ accounts: { test: structuredClone(account) } });
	t.after(f.cleanup);
	const input = feishuMessageToInput(f.conversation, event());
	assert.ok(input);
	assert.equal(input.userId, "ou_user");
	assert.equal(input?.mentionedBot, true);
	assert.equal(input?.text, "<@ou_bot> hello");
	f.conversation.channel.id = "oc_other";
	assert.equal(feishuMessageToInput(f.conversation, event()), undefined);
	f.conversation.channel.id = "oc_room";
	const self = event();
	if (self.event?.sender) self.event.sender.sender_id = { open_id: "ou_bot" };
	assert.equal(feishuMessageToInput(f.conversation, self), undefined);
	const runtime = await ConversationRuntime.connect(f.conversation, `pi-chat-${process.pid}-feishu`);
	t.after(() => runtime.disconnect());
	assert.deepEqual(runtime.parseControlCommand({ ...input, text: "<@ou_bot> stop" }), { name: "stop" });
});

test("Feishu rich-text posts recognize at nodes and unsupported media are explicit", async (t) => {
	const f = await fixture({ accounts: { test: structuredClone(account) } });
	t.after(f.cleanup);
	const post = event();
	assert.ok(post.event?.message);
	post.event.message.mentions = [];
	post.event.message.message_type = "post";
	post.event.message.content = JSON.stringify({
		zh_cn: {
			title: "Title",
			content: [
				[
					{ tag: "at", user_id: "ou_bot" },
					{ tag: "text", text: " hello" },
				],
			],
		},
	});
	const input = feishuMessageToInput(f.conversation, post);
	assert.equal(input?.mentionedBot, true);
	assert.equal(input?.text, "Title\n<@ou_bot> hello");
	post.event.message.message_type = "image";
	assert.match(feishuMessageToInput(f.conversation, post)?.text ?? "", /Unsupported Feishu message type: image/);
});

test("Feishu REST uses Lark domain, caches and refreshes tenant access tokens", async (t) => {
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	let tokens = 0;
	let calls = 0;
	globalThis.fetch = async (input) => {
		const url = String(input);
		assert.ok(url.startsWith("https://open.larksuite.com/"));
		if (url.includes("tenant_access_token")) {
			tokens++;
			return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
		}
		calls++;
		if (calls === 2) return Response.json({ code: 99991663 });
		return Response.json({ code: 0, bot: { open_id: "ou_bot", app_name: "Pi" } });
	};
	const client = new FeishuClient({ ...account, domain: "lark" });
	assert.equal((await client.identity()).id, "ou_bot");
	await client.identity();
	await client.identity();
	assert.equal(tokens, 2);
});

test("Feishu HTTP adapter challenge, authentication, serial dedup, reply chunking, upload and cleanup (mock REST)", async (t) => {
	const probe = createServer();
	await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
	const address = probe.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	await new Promise<void>((r, j) => probe.close((e) => (e ? j(e) : r())));
	const f = await fixture({ accounts: { test: { ...structuredClone(account), webhook: { port } } } });
	t.after(f.cleanup);
	const runtime = await ConversationRuntime.connect(f.conversation, `pi-chat-${process.pid}-http`);
	t.after(() => runtime.disconnect());
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const sent: Array<{ url: string; body: any }> = [];
	globalThis.fetch = async (input, options) => {
		const url = String(input);
		if (url.startsWith("http://127.0.0.1")) return original(input, options);
		assert.ok(url.startsWith("https://open.feishu.cn/"));
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		sent.push({ url, body: options?.body instanceof FormData ? options.body : JSON.parse(String(options?.body)) });
		if (url.endsWith("/im/v1/files")) return Response.json({ code: 0, data: { file_key: "file-key" } });
		return Response.json({ code: 0, data: { message_id: `sent-${sent.length}` } });
	};
	let received = 0;
	const handlers = {
		onCaughtUp: async () => {
			runtime.armAfterCurrentTail();
		},
		onMessage: async (input: Parameters<typeof runtime.ingestInbound>[0], checkpoint?: { messageId?: string }) => {
			received++;
			await runtime.ingestInbound(input, checkpoint);
		},
		onError: async (error: Error) => {
			throw error;
		},
	};
	const live = await connectFeishuLive(f.conversation, handlers);
	t.after(() => live.disconnect());
	const post = (body: unknown, path = "/feishu/events") =>
		original(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
	assert.equal((await post({}, "/wrong")).status, 404);
	assert.equal((await post({ token: "wrong" })).status, 403);
	assert.deepEqual(await (await post({ type: "url_verification", token: "verify", challenge: "hello" })).json(), {
		challenge: "hello",
	});
	await Promise.all([post(event()), post(event())]);
	assert.equal(received, 1);
	await writeFile(join(f.conversation.workspaceDir, "file.txt"), "file");
	await live.send("你好".repeat(2500), [join(f.conversation.workspaceDir, "file.txt")], undefined, "om_1");
	assert.ok(sent[0].url.endsWith("/om_1/reply"));
	assert.equal(sent.filter((item) => item.body.msg_type === "text").length, 3);
	assert.equal(sent.at(-1)?.body.msg_type, "file");
	assert.equal(runtime.beginNextJob()?.triggerMessageId, "om_1");
	await live.disconnect();
	await live.disconnect();
	const reconnected = await connectFeishuLive(f.conversation, handlers);
	t.after(() => reconnected.disconnect());
	await post(event());
	assert.equal(received, 1);
	await post(event("om_2"));
	assert.equal(received, 2);
	assert.equal(
		(
			await original(`http://127.0.0.1:${port}/feishu/events?foo=1`, {
				method: "POST",
				body: JSON.stringify(event("om_q")),
			})
		).status,
		200,
	);
	assert.equal(received, 3);
	assert.equal((await original(`http://127.0.0.1:${port}/feishu/events`, { method: "POST", body: "{" })).status, 403);
	assert.equal(
		(await original(`http://127.0.0.1:${port}/feishu/events`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) }))
			.status,
		413,
	);
});

test("Feishu GET retries one transient failure and message sends are not retried", async (t) => {
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	let gets = 0;
	let posts = 0;
	globalThis.fetch = async (input, options) => {
		const url = String(input);
		if (url.includes("tenant_access_token"))
			return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
		if (options?.body) {
			posts++;
			return Response.json({ code: 500, msg: "unavailable" }, { status: 500 });
		}
		gets++;
		if (gets === 1) return new Response("nope", { status: 500 });
		return Response.json({ code: 0, bot: { open_id: "ou_bot", app_name: "Pi" } });
	};
	const client = new FeishuClient(account);
	assert.equal((await client.identity()).id, "ou_bot");
	assert.equal(gets, 2);
	await assert.rejects(client.request("/im/v1/messages", { receive_id: "oc_room" }), /failed/);
	assert.equal(posts, 1);
});

test("Feishu listener fails when the webhook port is already taken", async (t) => {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	assert.ok(address && typeof address === "object");
	t.after(() => new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve()))));
	const f = await fixture({
		accounts: { test: { ...structuredClone(account), webhook: { port: address.port } } },
	});
	t.after(f.cleanup);
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
	};
	await assert.rejects(
		connectFeishuLive(f.conversation, {
			onCaughtUp: async () => {},
			onMessage: async () => {},
			onError: async () => {},
		}),
		/EADDRINUSE/,
	);
});

test("Feishu signed callbacks reject replays and missing reply targets fall back to a normal send", async (t) => {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
	const f = await fixture({
		accounts: { test: { ...structuredClone(account), encryptKey: "key", webhook: { port } } },
	});
	t.after(f.cleanup);
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const sent: string[] = [];
	globalThis.fetch = async (input, options) => {
		const url = String(input);
		if (url.startsWith("http://127.0.0.1")) return original(input, options);
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		sent.push(url);
		if (url.includes("/reply")) return Response.json({ code: 230011, msg: "message not found" });
		return Response.json({ code: 0, data: { message_id: "sent-fallback" } });
	};
	let received = 0;
	const live = await connectFeishuLive(f.conversation, {
		onCaughtUp: async () => {},
		onMessage: async () => {
			received++;
		},
		onError: async (error) => {
			throw error;
		},
	});
	t.after(() => live.disconnect());
	const enc = encrypted(event("om_enc"), "key");
	const postRaw = () =>
		original(`http://127.0.0.1:${port}/feishu/events`, {
			method: "POST",
			headers: enc.headers,
			body: enc.raw,
		});
	assert.equal((await postRaw()).status, 200);
	assert.equal((await postRaw()).status, 403);
	assert.equal(received, 1);
	await live.send("hello", [], undefined, "om_missing");
	assert.ok(sent.some((url) => url.includes("/reply")));
	assert.ok(sent.some((url) => url.includes("receive_id_type=chat_id")));
});

const wsAppId = "cli_a1b2c3d4e5f67890";

test("Feishu WebSocket mode uses EventDispatcher without a token, port, or live socket", async (t) => {
	assert.equal(feishuSdkDomain("lark"), Domain.Lark);
	assert.equal(feishuSdkDomain("feishu"), Domain.Feishu);
	assert.equal(feishuSdkDomain(undefined), Domain.Feishu);
	const client = createFeishuWsClient({
		...account,
		appId: wsAppId,
		domain: "lark",
		eventMode: "websocket",
	});
	t.after(() => client.close({ force: true }));
	assert.ok(client instanceof WSClient);
	const inspected = client as unknown as {
		pingTimeoutSec?: number;
		wsConfig?: { getWS: () => { autoReconnect?: boolean } };
	};
	assert.equal(inspected.wsConfig?.getWS().autoReconnect, false);
	assert.equal(inspected.pingTimeoutSec, 45);
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	assert.ok(address && typeof address === "object");
	t.after(() => new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve()))));
	const f = await fixture({
		accounts: {
			test: {
				...structuredClone(account),
				appId: wsAppId,
				eventMode: "websocket",
				verificationToken: undefined,
				encryptKey: "unused-for-ws",
				webhook: { port: address.port },
			},
		},
	});
	t.after(f.cleanup);
	assert.equal(resolveFeishuEventMode(f.conversation.account as FeishuAccountConfig), "websocket");
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const sent: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		sent.push(url);
		return Response.json({ code: 0, data: { message_id: "sent-ws" } });
	};
	let received = 0;
	let closed = false;
	let dispatcher: EventDispatcher | undefined;
	const live = await connectFeishuLive(
		f.conversation,
		{
			onCaughtUp: async () => {},
			onMessage: async () => {
				received++;
			},
			onError: async (error) => {
				throw error;
			},
		},
		{
			wsSessionFactory: () => ({
				async start(next) {
					dispatcher = next as EventDispatcher;
				},
				close() {
					closed = true;
				},
			}),
		},
	);
	t.after(() => live.disconnect());
	assert.ok(dispatcher instanceof EventDispatcher);
	const envelope = {
		schema: "2.0",
		header: {
			event_id: "ev_ws",
			event_type: "im.message.receive_v1",
			app_id: wsAppId,
			token: "",
		},
		event: event("om_ws").event,
	};
	await dispatcher.invoke({ ...envelope, header: { ...envelope.header, app_id: "cli_other" } }, { needCheck: false });
	assert.equal(received, 0);
	await dispatcher.invoke(envelope, { needCheck: false });
	await dispatcher.invoke(envelope, { needCheck: false });
	assert.equal(received, 1);
	const flattened = feishuEventFromSdkData({
		event_type: "im.message.receive_v1",
		app_id: wsAppId,
		sender: event("om_flat").event?.sender,
		message: event("om_flat").event?.message,
	});
	assert.equal(feishuMessageToInput(f.conversation, flattened)?.messageId, "om_flat");
	await live.send("ws-ok", [], undefined, "om_ws");
	assert.ok(sent.some((url) => url.includes("/om_ws/reply")));
	await live.disconnect();
	assert.equal(closed, true);
});

test("Feishu WebSocket rejects a non-SDK App ID before any platform call and legacy configs stay HTTP", async (t) => {
	const f = await fixture({
		accounts: { test: { ...structuredClone(account), eventMode: "websocket", verificationToken: undefined } },
	});
	t.after(f.cleanup);
	let fetched = false;
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	globalThis.fetch = async () => {
		fetched = true;
		throw new Error("Feishu network must not be called");
	};
	await assert.rejects(
		connectFeishuLive(f.conversation, {
			onCaughtUp: async () => {},
			onMessage: async () => {},
			onError: async () => {},
		}),
		/App ID/,
	);
	assert.equal(fetched, false);
	(f.conversation.account as FeishuAccountConfig).eventMode = undefined;
	await assert.rejects(
		connectFeishuLive(f.conversation, {
			onCaughtUp: async () => {},
			onMessage: async () => {},
			onError: async () => {},
		}),
		/Verification Token/,
	);
	assert.equal(fetched, false);
});

test("Feishu reaction switches default on and can be disabled by account config or FEISHU_REACTIONS", () => {
	assert.equal(feishuReactionsEnabled(undefined, {}), true);
	assert.equal(feishuReactionsEnabled(false, {}), false);
	assert.equal(feishuReactionsEnabled({ enabled: false }, {}), false);
	assert.equal(feishuReactionsEnabled(true, { FEISHU_REACTIONS: "false" }), false);
	assert.equal(feishuReactionsEnabled(undefined, { FEISHU_REACTIONS: "0" }), false);
	assert.equal(feishuReactionsEnabled(undefined, { FEISHU_REACTIONS: "no" }), false);
	assert.equal(feishuReactionsEnabled(undefined, { FEISHU_REACTIONS: "off" }), false);
	assert.equal(feishuReactionsEnabled(undefined, { FEISHU_REACTIONS: "true" }), true);
	assert.deepEqual(feishuReactionEmojis(undefined), { inProgress: "Typing", failure: "CrossMark" });
	assert.deepEqual(feishuReactionEmojis({ inProgress: "OnIt", failure: "CrossMark" }), {
		inProgress: "OnIt",
		failure: "CrossMark",
	});
});

test("Feishu status reactions are idempotent and only add CrossMark after Typing is removed", async (t) => {
	const f = await fixture({
		accounts: {
			test: {
				...structuredClone(account),
				appId: wsAppId,
				eventMode: "websocket",
				reactions: { inProgress: "Typing", failure: "CrossMark" },
			},
		},
	});
	t.after(f.cleanup);
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const calls: Array<{ url: string; method: string; emoji?: string }> = [];
	let failDelete = false;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		const emoji = init?.body
			? (JSON.parse(String(init.body)) as { reaction_type?: { emoji_type?: string } }).reaction_type?.emoji_type
			: undefined;
		calls.push({ url, method, emoji });
		if (method === "DELETE" && failDelete) return Response.json({ code: 230011, msg: "message not found" });
		if (url.endsWith("/reactions"))
			return Response.json({ code: 0, data: { reaction_id: `reaction-${calls.length}` } });
		return Response.json({ code: 0, data: {} });
	};
	const live = await connectFeishuLive(
		f.conversation,
		{ onCaughtUp: async () => {}, onMessage: async () => {}, onError: async () => {} },
		{ wsSessionFactory: () => ({ async start() {}, close() {} }) },
	);
	t.after(() => live.disconnect());
	await live.startTyping();
	assert.equal(calls.filter((call) => call.url.includes("/reactions")).length, 0);
	live.setReplyTo("om_trigger");
	await live.startTyping();
	await live.startTyping();
	assert.deepEqual(
		calls.filter((call) => call.method === "POST" && call.url.endsWith("/reactions")).map((call) => call.emoji),
		["Typing"],
	);
	await live.stopTyping();
	assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
	await live.markOutcome?.("om_trigger", "success");
	assert.equal(calls.filter((call) => call.emoji === "CrossMark").length, 0);

	calls.length = 0;
	await live.startTyping();
	await live.stopTyping();
	await live.markOutcome?.("om_trigger", "cancelled");
	assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
	assert.equal(calls.filter((call) => call.emoji === "CrossMark").length, 0);

	calls.length = 0;
	failDelete = true;
	await live.startTyping();
	await live.stopTyping();
	await live.markOutcome?.("om_trigger", "failure");
	assert.equal(calls.filter((call) => call.emoji === "CrossMark").length, 0);
	assert.equal(calls.filter((call) => call.method === "POST").length, 1);

	calls.length = 0;
	failDelete = false;
	await live.markOutcome?.("om_trigger", "failure");
	assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
	assert.deepEqual(
		calls.filter((call) => call.emoji === "CrossMark").map((call) => call.method),
		["POST"],
	);
	await live.markOutcome?.("om_trigger", "failure");
	assert.equal(calls.filter((call) => call.emoji === "CrossMark").length, 1);
});

test("Feishu reaction API failures and disable switches do not affect the connection", async (t) => {
	const f = await fixture({
		accounts: {
			test: { ...structuredClone(account), appId: wsAppId, eventMode: "websocket", reactions: false },
		},
	});
	t.after(f.cleanup);
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const urls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		urls.push(url);
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		throw new Error("reaction API down");
	};
	const live = await connectFeishuLive(
		f.conversation,
		{ onCaughtUp: async () => {}, onMessage: async () => {}, onError: async () => {} },
		{ wsSessionFactory: () => ({ async start() {}, close() {} }), env: { FEISHU_REACTIONS: "true" } },
	);
	t.after(() => live.disconnect());
	live.setReplyTo("om_off");
	await live.startTyping();
	await live.stopTyping();
	await live.markOutcome?.("om_off", "failure");
	assert.equal(
		urls.some((url) => url.includes("/reactions")),
		false,
	);

	const enabled = await fixture({
		accounts: { test: { ...structuredClone(account), appId: wsAppId, eventMode: "websocket" } },
	});
	t.after(enabled.cleanup);
	const noisy = await connectFeishuLive(
		enabled.conversation,
		{ onCaughtUp: async () => {}, onMessage: async () => {}, onError: async () => {} },
		{ wsSessionFactory: () => ({ async start() {}, close() {} }), env: { FEISHU_REACTIONS: "off" } },
	);
	t.after(() => noisy.disconnect());
	noisy.setReplyTo("om_env");
	await noisy.startTyping();
	await noisy.markOutcome?.("om_env", "failure");
	assert.equal(urls.filter((url) => url.includes("/reactions")).length, 0);
	const failing = await fixture({
		accounts: { test: { ...structuredClone(account), appId: wsAppId, eventMode: "websocket" } },
	});
	t.after(failing.cleanup);
	let reactionCalls = 0;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		reactionCalls++;
		throw new Error("reaction API down");
	};
	const broken = await connectFeishuLive(
		failing.conversation,
		{ onCaughtUp: async () => {}, onMessage: async () => {}, onError: async () => {} },
		{ wsSessionFactory: () => ({ async start() {}, close() {} }) },
	);
	t.after(() => broken.disconnect());
	broken.setReplyTo("om_down");
	await broken.startTyping();
	await broken.stopTyping();
	await broken.markOutcome?.("om_down", "failure");
	assert.equal(reactionCalls, 1);
});

test("Feishu websocket health config is rejected before any platform call", async (t) => {
	const f = await fixture({
		accounts: {
			test: {
				...structuredClone(account),
				appId: wsAppId,
				eventMode: "websocket",
				websocket: { staleTimeoutMs: -1 },
			},
		},
	});
	t.after(f.cleanup);
	await assert.rejects(
		() =>
			connectFeishuLive(f.conversation, {
				onCaughtUp: async () => {},
				onMessage: async () => {},
				onError: async () => {},
			}),
		/staleTimeoutMs/,
	);
});

test("Feishu websocket reconnect keeps message dedup and still accepts a new event", async (t) => {
	const f = await fixture({
		accounts: { test: { ...structuredClone(account), appId: wsAppId, eventMode: "websocket" } },
	});
	t.after(f.cleanup);
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token" });
		if (url.endsWith("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
		return Response.json({ code: 0, data: { message_id: "sent" } });
	};
	const logs: string[] = [];
	const events: string[] = [];
	let hooks: { onLinkDown?: (reason: string) => void } = {};
	let dispatcher: EventDispatcher | undefined;
	const received: string[] = [];
	const live = await connectFeishuLive(
		f.conversation,
		{
			onCaughtUp: async () => {},
			onMessage: async (input) => {
				received.push(input.messageId ?? "");
			},
			onError: async (error) => {
				throw error;
			},
			onConnectionEvent: async (event) => {
				events.push(event.type);
			},
		},
		{
			wsSessionFactory: (_account, next) => {
				hooks = next;
				return {
					async start(nextDispatcher) {
						dispatcher = nextDispatcher as EventDispatcher;
					},
					close() {},
				};
			},
			wsControl: {
				sleep: async () => {},
				random: () => 1,
				schedule: () => ({ stop() {} }),
				log: (line) => logs.push(line),
			},
		},
	);
	t.after(() => live.disconnect());
	assert.equal(live.connectionStatus?.().state, "connected");
	assert.equal(live.connectionStatus?.().reconnectCount, 0);
	assert.ok(live.connectionStatus?.().lastActivityAt);
	const envelope = (id: string) => ({
		schema: "2.0",
		header: { event_id: `ev_${id}`, event_type: "im.message.receive_v1", app_id: wsAppId, token: "" },
		event: event(id).event,
	});
	await dispatcher?.invoke(envelope("om_again"), { needCheck: false });
	await dispatcher?.invoke(envelope("om_again"), { needCheck: false });
	assert.deepEqual(received, ["om_again"]);
	hooks.onLinkDown?.("socket close");
	for (let i = 0; i < 20 && !events.includes("reconnected"); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.ok(events.includes("disconnected"));
	assert.ok(events.includes("reconnecting"));
	assert.ok(events.includes("reconnected"));
	assert.match(logs.join("\n"), /WebSocket disconnected: socket close/);
	assert.match(logs.join("\n"), /WebSocket reconnected/);
	assert.equal(live.connectionStatus?.().state, "connected");
	assert.equal(live.connectionStatus?.().reconnectCount, 1);
	await dispatcher?.invoke(envelope("om_again"), { needCheck: false });
	await dispatcher?.invoke(envelope("om_new"), { needCheck: false });
	assert.deepEqual(received, ["om_again", "om_new"]);
});
