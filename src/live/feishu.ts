import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { Domain, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { resolveFeishuEventMode } from "../config.js";
import type { FeishuAccountConfig, FeishuReactionSettings, ResolvedConversation } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { consumeCardActionToken, feishuCardSelection, feishuChoiceCard, feishuPostBody } from "../feishu-cards.js";
import { readConversationLog } from "../log.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService } from "../render/format.js";
import { FeishuClient } from "../services/feishu.js";
import { readLocalAttachment } from "./common.js";
import {
	attachFeishuWsActivityHooks,
	defaultFeishuWsLog,
	FEISHU_SDK_PING_TIMEOUT_SEC,
	FEISHU_WS_PROTOCOL_PING_MS,
	type FeishuWsHealthConfig,
	type FeishuWsHooks,
	type FeishuWsLinkEvent,
	type FeishuWsSession,
	FeishuWsSupervisor,
	type FeishuWsSupervisorOptions,
	readFeishuSdkPingIntervalMs,
	resolveFeishuWsHealth,
} from "./feishu-ws.js";
import type { LiveConnection, LiveConnectionHandlers, LiveProcessingOutcome } from "./types.js";

/** Official SDK `WSClient.start` rejects any other App ID and returns without connecting. */
export const FEISHU_WS_APP_ID = /^cli_[0-9a-fA-F]{16}$/;
const FEISHU_WS_CONNECT_TIMEOUT_MS = 30_000;

export interface FeishuEvent {
	type?: string;
	challenge?: string;
	token?: string;
	header?: { event_id?: string; event_type?: string; app_id?: string; token?: string };
	event?: {
		sender?: { sender_id?: { open_id?: string }; sender_type?: string };
		message?: {
			message_id?: string;
			chat_id?: string;
			message_type?: string;
			content?: string;
			mentions?: Array<{ key: string; name?: string; id?: { open_id?: string } }>;
		};
	};
}

/** Flattened schema 2.0 fields from EventDispatcher, or a nested envelope. */
export interface FeishuSdkMessageData {
	event_id?: string;
	token?: string;
	event_type?: string;
	app_id?: string;
	sender?: NonNullable<FeishuEvent["event"]>["sender"];
	message?: NonNullable<FeishuEvent["event"]>["message"];
	header?: FeishuEvent["header"];
	event?: FeishuEvent["event"];
	schema?: string;
}

export type { FeishuWsHooks, FeishuWsSession } from "./feishu-ws.js";

export type FeishuWsSessionFactory = (account: FeishuAccountConfig, hooks: FeishuWsHooks) => FeishuWsSession;

export interface ConnectFeishuLiveOptions {
	/** Test seam. Production waits for the official WSClient handshake and does not open a Feishu socket in unit tests. */
	wsSessionFactory?: FeishuWsSessionFactory;
	/** Test seam. Production reads `process.env`, including `FEISHU_REACTIONS`. */
	env?: NodeJS.ProcessEnv;
	/** Test seam. Production uses `account.websocket` and real timers. */
	wsControl?: {
		now?: FeishuWsSupervisorOptions["now"];
		sleep?: FeishuWsSupervisorOptions["sleep"];
		random?: FeishuWsSupervisorOptions["random"];
		schedule?: FeishuWsSupervisorOptions["schedule"];
		log?: FeishuWsSupervisorOptions["log"];
		health?: unknown;
	};
}

const FEISHU_REACTION_CACHE = 1024;
const FEISHU_REACTIONS_OFF = new Set(["0", "false", "no", "off"]);

/** `FEISHU_REACTIONS=false|0|no|off` disables reactions even when the account leaves them on. */
export function feishuReactionsEnabled(
	reactions: FeishuAccountConfig["reactions"],
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env.FEISHU_REACTIONS;
	if (typeof raw === "string" && FEISHU_REACTIONS_OFF.has(raw.trim().toLowerCase())) return false;
	if (reactions === false) return false;
	if (reactions && typeof reactions === "object" && reactions.enabled === false) return false;
	return true;
}

export function feishuReactionEmojis(reactions: FeishuAccountConfig["reactions"]): {
	inProgress: string;
	failure: string;
} {
	const settings: FeishuReactionSettings | undefined =
		reactions && typeof reactions === "object" ? reactions : undefined;
	return {
		inProgress: settings?.inProgress?.trim() || "Typing",
		failure: settings?.failure?.trim() || "CrossMark",
	};
}

function equal(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function feishuRequestPath(url: string | undefined): string {
	if (!url) return "";
	const query = url.indexOf("?");
	return query === -1 ? url : url.slice(0, query);
}

export function consumeFeishuNonce(seen: Set<string>, timestamp: string, nonce: string): void {
	const key = `${timestamp}\0${nonce}`;
	if (seen.has(key)) throw new Error("Replayed Feishu signature");
	seen.add(key);
}

/** IM 23xxxx means the reply target was rejected. Do not fall back on auth, rate-limit, or server errors. */
export function isFeishuReplyTargetError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const code = Number(message.match(/\((\d+)\)/)?.[1]);
	if (!Number.isFinite(code)) return false;
	if (code === 429 || (code >= 500 && code < 600) || [99991663, 99991664, 99991665, 99991400].includes(code))
		return false;
	return code >= 230000 && code < 240000;
}

export function feishuSdkDomain(domain: FeishuAccountConfig["domain"]): Domain {
	return domain === "lark" ? Domain.Lark : Domain.Feishu;
}

export function assertFeishuWebSocketAppId(appId: string): void {
	if (!FEISHU_WS_APP_ID.test(appId))
		throw new Error(
			"Feishu WebSocket mode requires an App ID matching cli_ plus 16 hex characters; the official SDK will not connect otherwise.",
		);
}

/** Map either the SDK's flattened handler payload or a schema 2.0 envelope onto the HTTP event shape. */
export function feishuEventFromSdkData(data: FeishuSdkMessageData): FeishuEvent {
	const nested = Boolean(data.header?.event_type || data.event?.message || data.event?.sender);
	if (nested) {
		return {
			header: {
				event_id: data.header?.event_id ?? data.event_id,
				event_type: data.header?.event_type ?? data.event_type,
				app_id: data.header?.app_id ?? data.app_id,
				token: data.header?.token ?? data.token,
			},
			event: data.event ?? { sender: data.sender, message: data.message },
		};
	}
	return {
		header: {
			event_id: data.event_id,
			event_type: data.event_type,
			app_id: data.app_id,
			token: data.token,
		},
		event: data.sender || data.message ? { sender: data.sender, message: data.message } : undefined,
	};
}

export function createFeishuWsClient(
	account: FeishuAccountConfig,
	callbacks?: {
		onReady?: () => void;
		onError?: (error: Error) => void;
		onReconnecting?: () => void;
		onReconnected?: () => void;
	},
): WSClient {
	return new WSClient({
		appId: account.appId,
		appSecret: account.appSecret,
		domain: feishuSdkDomain(account.domain),
		loggerLevel: LoggerLevel.warn,
		logger: {
			error: (message: unknown) => console.error("[pi-chat feishu] sdk", message),
			warn: (message: unknown) => console.error("[pi-chat feishu] sdk", message),
			info: () => undefined,
			debug: () => undefined,
			trace: () => undefined,
		},
		// The SDK ladder misses half-open sockets and can stop on server codes such as
		// exceed_conn_limit. Rebuilding here would also race that ladder, so it stays off.
		autoReconnect: false,
		handshakeTimeoutMs: 15_000,
		wsConfig: { pingTimeout: FEISHU_SDK_PING_TIMEOUT_SEC },
		source: "pi-chat",
		onReady: callbacks?.onReady,
		onError: callbacks?.onError,
		onReconnecting: callbacks?.onReconnecting,
		onReconnected: callbacks?.onReconnected,
	});
}

/**
 * Long-connection events are plaintext after the SDK authenticates the socket.
 * HTTP callbacks keep the stricter raw-body verifier; do not route them through this dispatcher.
 */
export function createFeishuMessageDispatcher(
	account: Pick<FeishuAccountConfig, "verificationToken" | "encryptKey">,
	onMessage: (data: FeishuSdkMessageData) => Promise<void>,
): EventDispatcher {
	return new EventDispatcher({
		loggerLevel: LoggerLevel.error,
		verificationToken: account.verificationToken || undefined,
		encryptKey: account.encryptKey || undefined,
	}).register({
		"im.message.receive_v1": async (data) => {
			await onMessage(data);
		},
	});
}

export function createDefaultFeishuWsSession(account: FeishuAccountConfig, hooks: FeishuWsHooks = {}): FeishuWsSession {
	assertFeishuWebSocketAppId(account.appId);
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
	let handshakeSettled = false;
	let sessionClosed = false;
	const failHandshake = (error: Error) => {
		if (handshakeSettled) return;
		handshakeSettled = true;
		if (handshakeTimer) clearTimeout(handshakeTimer);
		const reject = rejectReady;
		resolveReady = undefined;
		rejectReady = undefined;
		reject?.(error);
	};
	const wrapped: FeishuWsHooks = {
		onActivity: (kind) => hooks.onActivity?.(kind),
		onLinkDown: (reason) => {
			if (!handshakeSettled) failHandshake(new Error(`Feishu WebSocket ${reason}`));
			hooks.onLinkDown?.(reason);
		},
	};
	const client = createFeishuWsClient(account, {
		onReady: () => {
			if (handshakeSettled) return;
			handshakeSettled = true;
			if (handshakeTimer) clearTimeout(handshakeTimer);
			hooks.onActivity?.("ready");
			resolveReady?.();
			resolveReady = undefined;
			rejectReady = undefined;
		},
		onError: (error) => {
			if (!handshakeSettled) {
				failHandshake(error);
				return;
			}
			hooks.onTerminalError?.(error);
			hooks.onLinkDown?.(`sdk error: ${error.message}`);
		},
	});
	const activity = attachFeishuWsActivityHooks(client, wrapped);
	if (!activity.instrumented) {
		console.error("[pi-chat feishu] unable to instrument WSClient; stale timeout is the only half-open signal");
	}
	const forceClose = () => {
		activity.releaseSocket();
		client.close({ force: true });
	};
	return {
		start(dispatcher) {
			if (sessionClosed) return Promise.reject(new Error("Feishu WebSocket closed"));
			return new Promise<void>((resolve, reject) => {
				handshakeTimer = setTimeout(() => {
					failHandshake(new Error("Feishu WebSocket connection timed out"));
					forceClose();
				}, FEISHU_WS_CONNECT_TIMEOUT_MS);
				resolveReady = () => resolve();
				rejectReady = (error) => {
					forceClose();
					reject(error);
				};
				void client.start({ eventDispatcher: dispatcher as EventDispatcher }).catch((error: unknown) => {
					failHandshake(error instanceof Error ? error : new Error(String(error)));
					forceClose();
				});
			});
		},
		close() {
			if (sessionClosed) return;
			sessionClosed = true;
			failHandshake(new Error("Feishu WebSocket closed"));
			forceClose();
		},
		socketState: () => {
			try {
				const state = client.getConnectionStatus().state;
				if (state === "connected") return "open";
				if (state === "connecting" || state === "reconnecting") return "unknown";
				return "closed";
			} catch {
				return "unknown";
			}
		},
		// Protocol pings (attachFeishuWsActivityHooks) bound the effective liveness interval.
		pingIntervalMs: () => Math.min(readFeishuSdkPingIntervalMs(client) ?? Infinity, FEISHU_WS_PROTOCOL_PING_MS),
	};
}

/** Authenticate before dispatch, including URL verification. Never trust a chat_id alone. */
export function decodeFeishuEvent(
	raw: string,
	headers: IncomingHttpHeaders,
	account: FeishuAccountConfig,
): FeishuEvent {
	let payload = JSON.parse(raw);
	if (!payload || typeof payload !== "object") throw new Error("Invalid Feishu payload");
	if (payload.encrypt) {
		if (!account.encryptKey || typeof payload.encrypt !== "string") throw new Error("Feishu Encrypt Key required");
		const encrypted = Buffer.from(payload.encrypt, "base64");
		const key = createHash("sha256").update(account.encryptKey).digest();
		const decipher = createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
		payload = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString("utf8"));
	}
	if (!payload || typeof payload !== "object") throw new Error("Invalid Feishu event");
	const event = payload as FeishuEvent;
	const token = event.header?.token ?? event.token;
	if (!account.verificationToken || typeof token !== "string" || !equal(token, account.verificationToken))
		throw new Error("Invalid Feishu verification token");
	if (event.header?.app_id && event.header.app_id !== account.appId) throw new Error("Feishu App ID mismatch");
	// URL verification is authenticated by its token; Feishu may omit signature headers for it.
	if (account.encryptKey && event.type !== "url_verification") {
		const timestamp = headers["x-lark-request-timestamp"];
		const nonce = headers["x-lark-request-nonce"];
		const signature = headers["x-lark-signature"];
		if (
			typeof timestamp !== "string" ||
			typeof nonce !== "string" ||
			typeof signature !== "string" ||
			!Number.isFinite(Number(timestamp)) ||
			Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
		)
			throw new Error("Invalid or expired Feishu signature");
		const expected = createHash("sha256")
			.update(timestamp + nonce + account.encryptKey + raw)
			.digest("hex");
		if (!equal(signature, expected)) throw new Error("Invalid Feishu signature");
	}
	return event;
}

export function feishuMessageToInput(
	conversation: ResolvedConversation,
	event: FeishuEvent,
): InboundMessageInput | undefined {
	if (event.header?.event_type !== "im.message.receive_v1") return undefined;
	const account = conversation.account as FeishuAccountConfig;
	const message = event.event?.message;
	const sender = event.event?.sender;
	const userId = sender?.sender_id?.open_id;
	if (!message?.message_id || message.chat_id !== conversation.channel.id || !userId || userId === account.botUserId)
		return undefined;
	const content = JSON.parse(message.content ?? "{}");
	let text: string;
	let mentionedBot = false;
	if (message.message_type === "text") text = typeof content.text === "string" ? content.text : "";
	else if (message.message_type === "post") {
		const post = content.content ? content : (content.zh_cn ?? content.en_us ?? {});
		const lines = (Array.isArray(post.content) ? post.content : []).map(
			(row: Array<{ text?: string; href?: string; tag?: string; user_id?: string }>) =>
				row
					.map((part) => {
						if (part.tag === "at") {
							mentionedBot ||= Boolean(account.botUserId && part.user_id === account.botUserId);
							return `<@${part.user_id}>`;
						}
						return part.text ?? part.href ?? "";
					})
					.join(""),
		);
		text = [post.title, ...lines].filter(Boolean).join("\n");
	} else text = `[Unsupported Feishu message type: ${message.message_type ?? "unknown"}]`;
	for (const mention of message.mentions ?? []) {
		const isBot = Boolean(account.botUserId && mention.id?.open_id === account.botUserId);
		mentionedBot ||= isBot;
		text = text
			.split(mention.key)
			.join(isBot ? `<@${account.botUserId}>` : `@${mention.name ?? mention.id?.open_id ?? "user"}`);
	}
	return { messageId: message.message_id, userId, text, mentionedBot, isBot: sender?.sender_type === "app" };
}

async function loadSeenMessageIds(conversation: ResolvedConversation): Promise<Set<string>> {
	return new Set(
		(await readConversationLog(conversation))
			.flatMap((record) =>
				record.type === "inbound"
					? [record.messageId]
					: record.type === "checkpoint" && record.messageId
						? [record.messageId]
						: [],
			)
			.slice(-10000),
	);
}

interface FeishuListedMessage {
	message_id?: string;
	msg_type?: string;
	create_time?: string;
	deleted?: boolean;
	chat_id?: string;
	sender?: { id?: string; id_type?: string; sender_type?: string };
	body?: { content?: string };
	mentions?: Array<{ key: string; id?: string; name?: string }>;
}

/** Convert an `im/v1/messages` list item into the receive_v1 event shape. User messages only. */
export function feishuListedMessageToEvent(item: FeishuListedMessage, chatId: string): FeishuEvent | undefined {
	if (!item.message_id || item.deleted || item.sender?.sender_type !== "user") return undefined;
	if (item.sender.id_type && item.sender.id_type !== "open_id") return undefined;
	return {
		header: { event_type: "im.message.receive_v1" },
		event: {
			sender: { sender_id: { open_id: item.sender.id }, sender_type: "user" },
			message: {
				message_id: item.message_id,
				chat_id: item.chat_id ?? chatId,
				message_type: item.msg_type,
				content: item.body?.content,
				mentions: item.mentions?.map((m) => ({ key: m.key, name: m.name, id: { open_id: m.id } })),
			},
		},
	};
}

/** Messages in a chat created at or after `sinceMs`, oldest first. */
export async function listFeishuMessagesSince(
	api: Pick<FeishuClient, "request">,
	chatId: string,
	sinceMs: number,
	maxPages = 5,
): Promise<FeishuListedMessage[]> {
	const out: FeishuListedMessage[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const query = new URLSearchParams({
			container_id_type: "chat",
			container_id: chatId,
			start_time: String(Math.max(0, Math.floor(sinceMs / 1000))),
			sort_type: "ByCreateTimeAsc",
			page_size: "50",
		});
		if (pageToken) query.set("page_token", pageToken);
		const result = await api.request<{
			data?: { items?: FeishuListedMessage[]; has_more?: boolean; page_token?: string };
		}>(`/im/v1/messages?${query}`, undefined, undefined, undefined, "GET");
		out.push(...(result.data?.items ?? []));
		if (!result.data?.has_more || !result.data.page_token) break;
		pageToken = result.data.page_token;
	}
	return out;
}

function rememberMessage(seen: Set<string>, messageId: string): void {
	seen.add(messageId);
	if (seen.size <= 10000) return;
	const first = seen.values().next().value;
	if (first) seen.delete(first);
}

function createFeishuOutbound(
	api: FeishuClient,
	conversation: ResolvedConversation,
): Pick<LiveConnection, "send" | "sendImmediate" | "sendRich" | "sendChoiceCard"> {
	const postMessage = async (
		type: string,
		content: Record<string, unknown>,
		replyTo: string | undefined,
		signal?: AbortSignal,
	) => {
		const result = await api.request<{ data?: { message_id?: string } }>(
			replyTo ? `/im/v1/messages/${encodeURIComponent(replyTo)}/reply` : "/im/v1/messages?receive_id_type=chat_id",
			{
				...(replyTo ? {} : { receive_id: conversation.channel.id }),
				msg_type: type,
				content: JSON.stringify(content),
			},
			signal,
		);
		if (!result.data?.message_id) throw new Error("Feishu send returned no message ID");
		return result.data.message_id;
	};
	const sendMessage = async (type: string, content: Record<string, string>, replyTo?: string, signal?: AbortSignal) => {
		if (!replyTo) return postMessage(type, content, undefined, signal);
		try {
			return await postMessage(type, content, replyTo, signal);
		} catch (error) {
			if (!isFeishuReplyTargetError(error)) throw error;
			return postMessage(type, content, undefined, signal);
		}
	};
	const send: LiveConnection["send"] = async (text, attachments = [], signal, replyTo) => {
		let first: string | undefined;
		// Conservative UTF-16 limit: comfortably below Feishu's 20 KB JSON content limit.
		const rendered = formatMarkdownForService("feishu", text).text;
		for (const part of chunkText(rendered, 2000).filter((part) => part.trim())) {
			const id = await sendMessage("text", { text: part }, first ? undefined : replyTo, signal);
			first ??= id;
		}
		for (const path of attachments) {
			const file = await readLocalAttachment(path);
			const form = new FormData();
			form.set("file_type", "stream");
			form.set("file_name", file.name);
			form.set("file", new Blob([Buffer.from(file.data)], { type: file.mimeType }), file.name);
			const uploaded = await api.request<{ data?: { file_key?: string } }>("/im/v1/files", form, signal);
			if (!uploaded.data?.file_key) throw new Error("Feishu upload returned no file key");
			const id = await sendMessage("file", { file_key: uploaded.data.file_key }, first ? undefined : replyTo, signal);
			first ??= id;
		}
		return first;
	};
	return {
		send,
		sendImmediate: (text, replyTo) => send(text, [], undefined, replyTo),
		sendRich: async (markdown, replyTo) => {
			try {
				return await postMessage("post", feishuPostBody(markdown), replyTo);
			} catch {
				return send(markdown, [], undefined, replyTo);
			}
		},
		sendChoiceCard: async (title, markdown, buttons, replyTo) => {
			try {
				return await postMessage("interactive", feishuChoiceCard(title, markdown, buttons), replyTo);
			} catch {
				return send(markdown, [], undefined, replyTo);
			}
		},
	};
}

function logReactionFailure(action: string, emoji: string, messageId: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[pi-chat feishu] ${action} reaction ${emoji} on ${messageId} failed: ${message}`);
}

function createFeishuReactions(
	api: FeishuClient,
	account: FeishuAccountConfig,
	env: NodeJS.ProcessEnv = process.env,
): Pick<LiveConnection, "startTyping" | "stopTyping" | "setReplyTo" | "markOutcome"> {
	const pending = new Map<string, string>();
	const removed = new Set<string>();
	let replyTo: string | undefined;
	let queue = Promise.resolve();
	const enqueue = (work: () => Promise<void>) => {
		const task = queue.then(work, work);
		queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	};
	const remember = (messageId: string, reactionId: string) => {
		pending.delete(messageId);
		pending.set(messageId, reactionId);
		while (pending.size > FEISHU_REACTION_CACHE) {
			const oldest = pending.keys().next().value;
			if (!oldest) break;
			pending.delete(oldest);
		}
	};
	const addReaction = async (messageId: string, emoji: string): Promise<string | undefined> => {
		try {
			const result = await api.request<{ data?: { reaction_id?: string } }>(
				`/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
				{ reaction_type: { emoji_type: emoji } },
				AbortSignal.timeout(8000),
				false,
			);
			if (!result.data?.reaction_id) {
				logReactionFailure("Add", emoji, messageId, new Error("no reaction_id"));
				return undefined;
			}
			return result.data.reaction_id;
		} catch (error) {
			logReactionFailure("Add", emoji, messageId, error);
			return undefined;
		}
	};
	const deleteReaction = async (messageId: string, reactionId: string, emoji: string): Promise<boolean> => {
		try {
			await api.request(
				`/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
				undefined,
				AbortSignal.timeout(8000),
				false,
				"DELETE",
			);
			return true;
		} catch (error) {
			logReactionFailure("Remove", emoji, messageId, error);
			return false;
		}
	};
	const removeTyping = async (messageId: string): Promise<boolean> => {
		const reactionId = pending.get(messageId);
		if (!reactionId) return removed.has(messageId);
		const emoji = feishuReactionEmojis(account.reactions).inProgress;
		if (!(await deleteReaction(messageId, reactionId, emoji))) return false;
		pending.delete(messageId);
		removed.delete(messageId);
		removed.add(messageId);
		while (removed.size > FEISHU_REACTION_CACHE) {
			const oldest = removed.keys().next().value;
			if (!oldest) break;
			removed.delete(oldest);
		}
		return true;
	};
	return {
		setReplyTo(messageId) {
			replyTo = messageId;
		},
		startTyping() {
			return enqueue(async () => {
				const messageId = replyTo;
				if (!messageId || !feishuReactionsEnabled(account.reactions, env) || pending.has(messageId)) return;
				removed.delete(messageId);
				const reactionId = await addReaction(messageId, feishuReactionEmojis(account.reactions).inProgress);
				if (reactionId) remember(messageId, reactionId);
			});
		},
		stopTyping() {
			return enqueue(async () => {
				if (!replyTo) return;
				await removeTyping(replyTo);
			});
		},
		markOutcome(messageId, outcome: LiveProcessingOutcome) {
			return enqueue(async () => {
				if (!messageId) return;
				// CrossMark only after this turn's Typing reaction was actually deleted.
				const removedOk = await removeTyping(messageId);
				if (!removedOk) return;
				removed.delete(messageId);
				if (outcome !== "failure" || !feishuReactionsEnabled(account.reactions, env)) return;
				await addReaction(messageId, feishuReactionEmojis(account.reactions).failure);
			});
		},
	};
}

function idlePreview(): Pick<LiveConnection, "syncPreview" | "clearPreview"> {
	return {
		syncPreview: async () => [],
		clearPreview: async () => {},
	};
}

export async function connectFeishuLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	options?: ConnectFeishuLiveOptions,
): Promise<LiveConnection> {
	if (conversation.account.service !== "feishu") throw new Error("Expected Feishu account");
	const account = { ...conversation.account };
	const eventMode = resolveFeishuEventMode(account);
	let wsHealth: FeishuWsHealthConfig | undefined;
	if (eventMode === "http") {
		if (!account.verificationToken?.trim()) throw new Error("Feishu Verification Token is required");
		const path = account.webhook?.path ?? "/feishu/events";
		const port = account.webhook?.port ?? 3000;
		if (!path.startsWith("/") || !Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("Invalid Feishu webhook path or port");
	} else {
		assertFeishuWebSocketAppId(account.appId);
		wsHealth = resolveFeishuWsHealth(options?.wsControl?.health ?? account.websocket);
	}
	const api = new FeishuClient(account);
	account.botUserId = (await api.identity()).id;
	conversation.account.botUserId = account.botUserId;
	const seen = await loadSeenMessageIds(conversation);
	const outbound = createFeishuOutbound(api, conversation);
	const reactions = createFeishuReactions(api, account, options?.env);
	const report = (error: unknown) =>
		handlers.onError(error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
	const state = { closed: false };
	let queue = Promise.resolve();
	const ingest = async (event: FeishuEvent) => {
		const task = queue.then(async () => {
			if (state.closed) throw new Error("Feishu connection closed");
			const input = feishuMessageToInput(conversation, event);
			if (!input?.messageId || seen.has(input.messageId)) return;
			await handlers.onMessage(input, { messageId: input.messageId });
			rememberMessage(seen, input.messageId);
		});
		queue = task.catch(report);
		await task;
	};
	const cardTokens = new Map<string, number>();
	const emitCardAction = async (data: Parameters<typeof feishuCardSelection>[0]) => {
		const selection = feishuCardSelection(data);
		if (!selection || !consumeCardActionToken(cardTokens, selection.token)) return;
		await handlers.onMessage(
			{
				userId: selection.userId,
				text: `/pi-select ${selection.index}`,
				messageId: selection.token ? `card:${selection.token}` : undefined,
				mentionedBot: true,
			},
			selection.token ? { messageId: `card:${selection.token}` } : undefined,
		);
	};

	if (eventMode === "websocket") {
		const health = wsHealth ?? resolveFeishuWsHealth(account.websocket);
		const log = options?.wsControl?.log ?? defaultFeishuWsLog;
		if (health.staleTimeoutMs < FEISHU_WS_PROTOCOL_PING_MS * 2) {
			log(
				`[pi-chat feishu] websocket.staleTimeoutMs is below twice the ${FEISHU_WS_PROTOCOL_PING_MS}ms protocol ping interval; a healthy idle connection may be rebuilt.`,
			);
		}
		const factory = options?.wsSessionFactory ?? createDefaultFeishuWsSession;
		// Missed-event catch-up: when the link drops, remember the last activity
		// time; after reconnect, list the chat's messages since then and feed user
		// messages through `ingest`, which dedupes by message_id against live events.
		let downSince: number | undefined;
		const catchUp = async (sinceMs: number) => {
			const items = await listFeishuMessagesSince(api, conversation.channel.id, sinceMs - 5_000);
			let fed = 0;
			for (const item of items) {
				const event = feishuListedMessageToEvent(item, conversation.channel.id);
				const id = event?.event?.message?.message_id;
				if (!event || !id || seen.has(id)) continue;
				fed++;
				await ingest(event);
			}
			log(
				`${new Date().toISOString()} [pi-chat feishu] reconnect catch-up since ${new Date(sinceMs).toISOString()}: ${items.length} listed, ${fed} new`,
			);
		};
		const onLinkEvent = (event: FeishuWsLinkEvent) => {
			if ((event.type === "stale" || event.type === "disconnected") && downSince === undefined) {
				const last = event.status.lastActivityAt ? Date.parse(event.status.lastActivityAt) : Number.NaN;
				downSince = Number.isFinite(last) ? last : Date.now();
			} else if (event.type === "reconnected" && downSince !== undefined) {
				const since = downSince;
				downSince = undefined;
				void catchUp(since).catch((error: unknown) => {
					const text = error instanceof Error ? error.message : String(error);
					log(`${new Date().toISOString()} [pi-chat feishu] reconnect catch-up failed: ${text}`);
				});
			}
		};
		const supervisor = new FeishuWsSupervisor({
			health,
			createSession: (hooks) => factory(account, hooks),
			now: options?.wsControl?.now,
			sleep: options?.wsControl?.sleep,
			random: options?.wsControl?.random,
			schedule: options?.wsControl?.schedule,
			log,
			onEvent: (event) => {
				onLinkEvent(event);
				void Promise.resolve(handlers.onConnectionEvent?.(event)).catch(() => undefined);
			},
		});
		const dispatcher = createFeishuMessageDispatcher(account, async (data) => {
			supervisor.noteActivity("event");
			if (data.app_id && data.app_id !== account.appId) return;
			if (data.header?.app_id && data.header.app_id !== account.appId) return;
			const event = feishuEventFromSdkData(data);
			event.header = { ...event.header, event_type: event.header?.event_type ?? "im.message.receive_v1" };
			await ingest(event);
		});
		dispatcher.register({
			"card.action.trigger": async (data: Parameters<typeof feishuCardSelection>[0]) => {
				supervisor.noteActivity("event");
				await emitCardAction(data);
			},
		});
		// No catch-up at startup; reconnects catch up via onLinkEvent above.
		await handlers.onCaughtUp();
		try {
			await supervisor.start(dispatcher);
		} catch (error) {
			supervisor.close();
			throw error;
		}
		return {
			conversation,
			...outbound,
			...reactions,
			...idlePreview(),
			connectionStatus: () => supervisor.status(),
			disconnect: async () => {
				if (state.closed) return;
				state.closed = true;
				supervisor.close();
				await queue;
			},
		};
	}

	const path = account.webhook?.path ?? "/feishu/events";
	const port = account.webhook?.port ?? 3000;
	const nonces = new Set<string>();
	const server = createServer(async (req, res) => {
		if (state.closed || req.method !== "POST" || feishuRequestPath(req.url) !== path) {
			res.writeHead(404).end();
			return;
		}
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 1024 * 1024) {
					res.writeHead(413).end();
					req.destroy();
					return;
				}
				chunks.push(Buffer.from(chunk));
			}
			let event: FeishuEvent;
			try {
				event = decodeFeishuEvent(Buffer.concat(chunks).toString("utf8"), req.headers, account);
				if (account.encryptKey && event.type !== "url_verification") {
					const timestamp = req.headers["x-lark-request-timestamp"];
					const nonce = req.headers["x-lark-request-nonce"];
					if (typeof timestamp !== "string" || typeof nonce !== "string") throw new Error("Invalid Feishu signature");
					consumeFeishuNonce(nonces, timestamp, nonce);
				}
			} catch {
				res.writeHead(403).end();
				return;
			}
			if (event.type === "url_verification" && typeof event.challenge === "string") {
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: event.challenge }));
				return;
			}
			if (feishuCardSelection(event as Parameters<typeof feishuCardSelection>[0])) {
				await emitCardAction(event as Parameters<typeof feishuCardSelection>[0]);
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			// Serialize ingestion and acknowledge after it is logged, not after the model reply.
			try {
				await ingest(event);
			} catch (error) {
				if (!res.headersSent) res.writeHead(500).end();
				await report(error);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" }).end("{}");
		} catch (error) {
			if (!res.headersSent) res.writeHead(500).end();
			await report(error);
		}
	});
	server.requestTimeout = 10000;
	server.headersTimeout = 10000;
	// No historical catch-up API is used. Only newly delivered callbacks trigger jobs.
	await handlers.onCaughtUp();
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.close(() => undefined);
			reject(error);
		};
		server.once("error", onError);
		server.listen(port, account.webhook?.host ?? "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
	server.on("error", (error) => {
		void report(error);
	});
	return {
		conversation,
		...outbound,
		...reactions,
		...idlePreview(),
		disconnect: async () => {
			if (state.closed) return;
			state.closed = true;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeIdleConnections();
			});
			await queue;
		},
	};
}
