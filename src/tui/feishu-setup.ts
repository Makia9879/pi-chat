import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { saveChatConfig } from "../config.js";
import type { ChatConfig, FeishuAccountConfig, FeishuEventMode } from "../core/config-types.js";
import { makeAccountKey, makeChannelKey } from "../core/keys.js";
import { FEISHU_WS_APP_ID } from "../live/feishu.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot } from "../services/index.js";
import { runWithLoader, selectItem, showNotice } from "./dialogs.js";

export async function configureFeishuCredentials(
	ctx: ExtensionContext,
	current?: FeishuAccountConfig,
): Promise<FeishuAccountConfig | undefined> {
	const domain = await selectItem(ctx, "Feishu / Lark region", [
		{ value: "feishu", label: "Feishu (China)", description: "open.feishu.cn" },
		{ value: "lark", label: "Lark (International)", description: "open.larksuite.com" },
	]);
	if (!domain) return;
	const currentMode: FeishuEventMode = current?.eventMode ?? (current ? "http" : "websocket");
	const websocketChoice = {
		value: "websocket",
		label: "WebSocket long connection",
		description: "No public callback URL. Recommended for new accounts.",
	};
	const httpChoice = {
		value: "http",
		label: "HTTP callback",
		description: "Public HTTPS URL, verification token, and local port.",
	};
	const eventMode = await selectItem(
		ctx,
		`Event subscription (current: ${currentMode})`,
		currentMode === "http" ? [httpChoice, websocketChoice] : [websocketChoice, httpChoice],
	);
	if (eventMode !== "websocket" && eventMode !== "http") return;
	const appId =
		(await ctx.ui.input("App ID (empty keeps current)", current?.appId ?? "cli_..."))?.trim() || current?.appId;
	if (!appId) return;
	const appSecret = (await ctx.ui.input("App Secret (empty keeps current)", ""))?.trim() || current?.appSecret;
	if (!appSecret) return;

	let verificationToken = current?.verificationToken;
	let encryptKey = current?.encryptKey;
	let webhook = current?.webhook;
	if (eventMode === "http") {
		verificationToken =
			(await ctx.ui.input("Verification Token (empty keeps current)", ""))?.trim() || current?.verificationToken;
		if (!verificationToken) return;
		const encryptKeyInput = await ctx.ui.input(
			current
				? "Encrypt Key (empty keeps current; type - to disable)"
				: "Encrypt Key (optional; empty disables encryption)",
			"",
		);
		if (encryptKeyInput === undefined) return;
		encryptKey = current
			? encryptKeyInput.trim() === "-"
				? undefined
				: encryptKeyInput.trim() || current.encryptKey
			: encryptKeyInput.trim() || undefined;
		const portText = await ctx.ui.input("Webhook local port", String(current?.webhook?.port ?? 3000));
		if (portText === undefined) return;
		const port = Number(portText || current?.webhook?.port || 3000);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			await showNotice(ctx, "Invalid port", "Use a port from 1 to 65535", "error");
			return;
		}
		webhook = { ...current?.webhook, port };
	} else if (!FEISHU_WS_APP_ID.test(appId)) {
		await showNotice(
			ctx,
			"Invalid App ID",
			"WebSocket mode uses the official SDK, which requires an App ID of cli_ plus 16 hex characters.",
			"error",
		);
		return;
	}
	return {
		...current,
		service: "feishu",
		domain: domain as "feishu" | "lark",
		eventMode,
		appId,
		appSecret,
		verificationToken,
		encryptKey,
		webhook,
		channels: current?.channels ?? {},
		access: current?.access ?? { ignoreBots: true },
	};
}

export async function createFeishuAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	let account = await configureFeishuCredentials(ctx);
	if (!account) return;
	const label = await ctx.ui.input("Account label", "feishu-bot");
	if (label === undefined) return;
	account.name = label.trim() || "feishu-bot";
	const base = makeAccountKey("feishu", account.name);
	let key = base;
	for (let n = 2; config.accounts[key]; n++) key = `${base}-${n}`;
	const draft = account;
	const result = await runWithLoader(ctx, "Validating Feishu app...", () => refreshAccountSnapshot(key, draft));
	if (!result.value) {
		await showNotice(ctx, "Feishu setup error", result.error ?? "Validation failed", "error");
		return;
	}
	account = updateAccountIdentityFromSnapshot(account, result.value) as FeishuAccountConfig;
	config.accounts[key] = account;
	await saveChatConfig(config);
	const modeNote =
		account.eventMode === "websocket"
			? "Add a chat_id, publish the app, and in the Feishu/Lark console choose long-connection (WebSocket) subscription for im.message.receive_v1. No public callback URL is required."
			: "Add a chat_id, then connect and configure an HTTPS event callback to the local webhook. See README.";
	await showNotice(ctx, "Feishu account created", `Created ${key}. ${modeNote}`, "info");
	return key;
}

export async function addFeishuChannel(
	ctx: ExtensionContext,
	config: ChatConfig,
	accountId: string,
	account: FeishuAccountConfig,
): Promise<void> {
	const id = (await ctx.ui.input("Feishu chat_id", "oc_..."))?.trim();
	if (!id) return;
	if (!/^oc_[A-Za-z0-9_-]+$/.test(id)) {
		await showNotice(ctx, "Invalid chat ID", "Expected a chat_id beginning with oc_", "error");
		return;
	}
	const name = await ctx.ui.input("Channel name", id);
	if (name === undefined) return;
	const dm = await ctx.ui.confirm(
		"Direct message?",
		"Yes: every message triggers. No: only bot mentions trigger by default.",
	);
	const allowed = await ctx.ui.input("Allowed user open_ids (comma separated; empty allows everyone)", "ou_...");
	if (allowed === undefined) return;
	let key = makeChannelKey(name || id, id);
	const base = key;
	for (let n = 2; account.channels[key] && account.channels[key].id !== id; n++) key = `${base}-${n}`;
	account.channels[key] = {
		...account.channels[key],
		id,
		name: name || id,
		dm,
		access: {
			trigger: dm ? "message" : "mention",
			ignoreBots: true,
			allowedUserIds: allowed
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean),
		},
	};
	config.accounts[accountId] = account;
	await saveChatConfig(config);
}
