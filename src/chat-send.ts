import { lstat } from "node:fs/promises";
import { loadChatConfig, resolveConversation } from "./config.js";
import type { ChatAccountConfig, ChatConfig, ChatService, ResolvedConversation } from "./core/config-types.js";
import { readLocalAttachment } from "./live/common.js";
import { appendConversationRecord, buildBaseRecordFields } from "./log.js";
import { chunkText } from "./render/chunking.js";
import { FeishuClient } from "./services/feishu.js";

const USAGE = "Usage: /chat-send <account/channel> [--file path]... [--image path]... [text]";
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ChatSendRequest {
	conversation: string;
	text?: string;
	files?: string[];
	images?: string[];
}

export interface ChatSendResult {
	service: ChatService;
	conversationId: string;
	messageIds: string[];
	logged: boolean;
	logWarning?: string;
}

export function parseChatSendArgs(input: string): ChatSendRequest {
	const tokens = tokenize(input.trim());
	if (tokens.length === 0) throw new Error(USAGE);
	const files: string[] = [];
	const images: string[] = [];
	const text: string[] = [];
	let conversation: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		const inlineFile = token.startsWith("--file=");
		const inlineImage = token.startsWith("--image=");
		if (token === "--file" || token === "--image" || inlineFile || inlineImage) {
			const image = token === "--image" || inlineImage;
			const value = inlineFile || inlineImage ? token.slice(token.indexOf("=") + 1) : tokens[++index];
			if (!value) throw new Error(`Missing path for ${image ? "--image" : "--file"}`);
			(image ? images : files).push(value);
			continue;
		}
		if (token.startsWith("--")) throw new Error(`Unknown option ${token}. ${USAGE}`);
		if (!conversation) {
			conversation = token;
			continue;
		}
		text.push(token);
	}
	if (!conversation?.includes("/")) throw new Error(USAGE);
	const joined = text.join(" ").trim();
	if (!joined && files.length === 0 && images.length === 0)
		throw new Error(`${USAGE}. Provide text, --file, or --image.`);
	return {
		conversation,
		text: joined || undefined,
		files: files.length ? files : undefined,
		images: images.length ? images : undefined,
	};
}

export function formatChatSendResult(result: ChatSendResult): string {
	const lines = [
		`Sent to ${result.conversationId} (${result.service})`,
		...result.messageIds.map((id) => `message_id: ${id}`),
		result.logged ? "logged: yes" : `logged: no (${result.logWarning ?? "channel log was not updated"})`,
	];
	return lines.join("\n");
}

export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
	let text = message;
	for (const secret of secrets) {
		if (!secret || secret.length < 6) continue;
		text = text.split(secret).join("[redacted]");
	}
	return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
}

export async function sendConfiguredChat(
	request: ChatSendRequest,
	options?: { config?: ChatConfig },
): Promise<ChatSendResult> {
	const config = options?.config ?? (await loadChatConfig());
	const conversation = resolveConversation(config, request.conversation);
	if (!conversation) {
		throw new Error(`Unknown channel: ${request.conversation}. Use account/channel from /chat-list.`);
	}
	return sendChatMessage(conversation, request);
}

/** Push to one already-resolved channel. Does not connect, and does not take the conversation lock. */
export async function sendChatMessage(
	conversation: ResolvedConversation,
	request: Pick<ChatSendRequest, "text" | "files" | "images">,
): Promise<ChatSendResult> {
	const text = request.text?.trim() ?? "";
	const files = request.files ?? [];
	const images = request.images ?? [];
	if (!text && files.length === 0 && images.length === 0) {
		throw new Error(`${USAGE}. Provide text, --file, or --image.`);
	}
	await assertLocalFiles(files, MAX_FILE_BYTES, "file");
	await assertLocalFiles(images, MAX_IMAGE_BYTES, "image");
	const secrets = accountSecrets(conversation.account);
	const sent: Array<{ id: string; text: string; paths: string[] }> = [];
	try {
		const ids = await deliver(conversation, text, files, images);
		for (const item of ids) sent.push(item);
	} catch (error) {
		const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
		const partial = sent.length ? ` after sending ${sent.map((item) => item.id).join(", ")}` : "";
		if (sent.length) await recordOutbound(conversation, sent);
		throw new Error(`chat-send failed${partial}: ${message}`);
	}
	const logged = await recordOutbound(conversation, sent);
	return {
		service: conversation.service,
		conversationId: conversation.conversationId,
		messageIds: sent.map((item) => item.id),
		logged: logged.logged,
		logWarning: logged.warning,
	};
}

function accountSecrets(account: ChatAccountConfig): string[] {
	if (account.service === "feishu") return [account.appSecret];
	return [account.botToken];
}

async function assertLocalFiles(paths: string[], limit: number, label: string): Promise<void> {
	for (const path of paths) {
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch {
			throw new Error(`${label} not found: ${path}`);
		}
		if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
		if (info.size > limit) throw new Error(`${label} is too large (${info.size} bytes): ${path}`);
	}
}

async function deliver(
	conversation: ResolvedConversation,
	text: string,
	files: string[],
	images: string[],
): Promise<Array<{ id: string; text: string; paths: string[] }>> {
	if (conversation.service === "feishu") return deliverFeishu(conversation, text, files, images);
	if (conversation.service === "discord") return deliverDiscord(conversation, text, files, images);
	if (conversation.service === "telegram") return deliverTelegram(conversation, text, files, images);
	throw new Error(`chat-send does not support ${conversation.service}`);
}

async function deliverFeishu(
	conversation: ResolvedConversation,
	text: string,
	files: string[],
	images: string[],
): Promise<Array<{ id: string; text: string; paths: string[] }>> {
	if (conversation.account.service !== "feishu") throw new Error("Expected Feishu account");
	const api = new FeishuClient(conversation.account);
	const chatId = conversation.channel.id;
	const sent: Array<{ id: string; text: string; paths: string[] }> = [];
	for (const part of text ? chunkText(text, 2000).filter((part) => part.trim()) : []) {
		sent.push({ id: await feishuMessage(api, chatId, "text", { text: part }), text: part, paths: [] });
	}
	for (const path of files) {
		const file = await readLocalAttachment(path);
		const form = new FormData();
		form.set("file_type", "stream");
		form.set("file_name", file.name);
		form.set(
			"file",
			new Blob([Buffer.from(file.data)], { type: file.mimeType ?? "application/octet-stream" }),
			file.name,
		);
		const uploaded = await api.request<{ data?: { file_key?: string } }>("/im/v1/files", form);
		if (!uploaded.data?.file_key) throw new Error("Feishu upload returned no file key");
		sent.push({
			id: await feishuMessage(api, chatId, "file", { file_key: uploaded.data.file_key }),
			text: `[file] ${file.name}`,
			paths: [path],
		});
	}
	for (const path of images) {
		const file = await readLocalAttachment(path);
		const form = new FormData();
		form.set("image_type", "message");
		form.set(
			"image",
			new Blob([Buffer.from(file.data)], { type: file.mimeType ?? "application/octet-stream" }),
			file.name,
		);
		const uploaded = await api.request<{ data?: { image_key?: string } }>("/im/v1/images", form);
		if (!uploaded.data?.image_key) throw new Error("Feishu upload returned no image key");
		sent.push({
			id: await feishuMessage(api, chatId, "image", { image_key: uploaded.data.image_key }),
			text: `[image] ${file.name}`,
			paths: [path],
		});
	}
	return sent;
}

async function feishuMessage(
	api: FeishuClient,
	chatId: string,
	type: string,
	content: Record<string, string>,
): Promise<string> {
	const result = await api.request<{ data?: { message_id?: string } }>("/im/v1/messages?receive_id_type=chat_id", {
		receive_id: chatId,
		msg_type: type,
		content: JSON.stringify(content),
	});
	if (!result.data?.message_id) throw new Error("Feishu send returned no message ID");
	return result.data.message_id;
}

async function deliverDiscord(
	conversation: ResolvedConversation,
	text: string,
	files: string[],
	images: string[],
): Promise<Array<{ id: string; text: string; paths: string[] }>> {
	if (conversation.account.service !== "discord") throw new Error("Expected Discord account");
	const token = conversation.account.botToken;
	const channelId = conversation.channel.id;
	const sent: Array<{ id: string; text: string; paths: string[] }> = [];
	for (const part of text ? chunkText(text, 2000).filter((part) => part.trim()) : []) {
		sent.push({ id: await discordMessage(token, channelId, part), text: part, paths: [] });
	}
	for (const path of [...files, ...images]) {
		const file = await readLocalAttachment(path);
		sent.push({
			id: await discordMessage(token, channelId, "", [file]),
			text: `[file] ${file.name}`,
			paths: [path],
		});
	}
	return sent;
}

async function discordMessage(
	token: string,
	channelId: string,
	content: string,
	files: Array<{ name: string; data: Uint8Array; mimeType?: string }> = [],
): Promise<string> {
	const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
	let body: BodyInit;
	const headers: Record<string, string> = { Authorization: `Bot ${token}` };
	if (files.length === 0) {
		headers["content-type"] = "application/json";
		body = JSON.stringify({ content });
	} else {
		const form = new FormData();
		form.set("payload_json", JSON.stringify({ content: content || undefined }));
		for (const [index, file] of files.entries()) {
			form.set(
				`files[${index}]`,
				new Blob([Buffer.from(file.data)], { type: file.mimeType ?? "application/octet-stream" }),
				file.name,
			);
		}
		body = form;
	}
	const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30000) });
	const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
	if (!response.ok || !data.id) throw new Error(data.message || `Discord send failed (${response.status})`);
	return data.id;
}

async function deliverTelegram(
	conversation: ResolvedConversation,
	text: string,
	files: string[],
	images: string[],
): Promise<Array<{ id: string; text: string; paths: string[] }>> {
	if (conversation.account.service !== "telegram") throw new Error("Expected Telegram account");
	const token = conversation.account.botToken;
	const chatId = conversation.channel.id;
	if (!/^-?\d+$/.test(chatId)) throw new Error(`Telegram channel id must be numeric, got ${chatId}`);
	const sent: Array<{ id: string; text: string; paths: string[] }> = [];
	for (const part of text ? chunkText(text, 4096).filter((part) => part.trim()) : []) {
		const id = await telegramJson<{ message_id: number }>(token, "sendMessage", {
			chat_id: Number(chatId),
			text: part,
		});
		sent.push({ id: String(id.message_id), text: part, paths: [] });
	}
	for (const path of files) {
		const file = await readLocalAttachment(path);
		const id = await telegramForm(token, "sendDocument", chatId, "document", file);
		sent.push({ id, text: `[file] ${file.name}`, paths: [path] });
	}
	for (const path of images) {
		const file = await readLocalAttachment(path);
		const id = await telegramForm(token, "sendPhoto", chatId, "photo", file);
		sent.push({ id, text: `[image] ${file.name}`, paths: [path] });
	}
	return sent;
}

async function telegramJson<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30000),
		});
	} catch (error) {
		throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), [token]));
	}
	const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
	if (!response.ok || !data.ok || data.result === undefined) {
		throw new Error(redactSecrets(data.description || `Telegram ${method} failed (${response.status})`, [token]));
	}
	return data.result;
}

async function telegramForm(
	token: string,
	method: string,
	chatId: string,
	field: string,
	file: { name: string; data: Uint8Array; mimeType?: string },
): Promise<string> {
	const form = new FormData();
	form.set("chat_id", chatId);
	form.set(field, new Blob([Buffer.from(file.data)], { type: file.mimeType ?? "application/octet-stream" }), file.name);
	let response: Response;
	try {
		response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(30000),
		});
	} catch (error) {
		throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), [token]));
	}
	const data = (await response.json().catch(() => ({}))) as {
		ok?: boolean;
		result?: { message_id: number };
		description?: string;
	};
	if (!response.ok || !data.ok || data.result?.message_id === undefined) {
		throw new Error(redactSecrets(data.description || `Telegram ${method} failed (${response.status})`, [token]));
	}
	return String(data.result.message_id);
}

async function recordOutbound(
	conversation: ResolvedConversation,
	sent: Array<{ id: string; text: string; paths: string[] }>,
): Promise<{ logged: boolean; warning?: string }> {
	try {
		for (const item of sent) {
			await appendConversationRecord(conversation, {
				type: "outbound",
				...buildBaseRecordFields(conversation, 0),
				messageId: item.id,
				text: item.text,
				jobId: "chat-send",
				attachments: item.paths.length ? item.paths : undefined,
			});
		}
		return { logged: true };
	} catch (error) {
		return { logged: false, warning: error instanceof Error ? error.message : String(error) };
	}
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < input.length) {
		while (input[index] === " " || input[index] === "\t") index++;
		if (index >= input.length) break;
		const quote = input[index];
		if (quote === "'" || quote === '"') {
			index++;
			let value = "";
			while (index < input.length && input[index] !== quote) {
				if (input[index] === "\\" && quote === '"') {
					index++;
					value += input[index] ?? "";
					index++;
					continue;
				}
				value += input[index++];
			}
			if (input[index] !== quote) throw new Error("Unclosed quote in /chat-send arguments");
			index++;
			tokens.push(value);
			continue;
		}
		let value = "";
		while (index < input.length && input[index] !== " " && input[index] !== "\t") value += input[index++];
		tokens.push(value);
	}
	return tokens;
}
