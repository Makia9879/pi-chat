import type { DockerConfig, DockerSettings } from "../docker-config.js";

export type ChatService = "telegram" | "discord" | "feishu";

export interface RuntimeConfig {
	mode?: "gondolin" | "local" | "docker";
	docker?: DockerConfig;
	/** Absolute host directory. Local mode defaults to /workspace. */
	workspaceDir?: string;
}

export type TriggerMode = "mention" | "message";

export interface AccessPolicy {
	trigger?: TriggerMode;
	ignoreBots?: boolean;
	allowedUserIds?: string[];
	allowedRoleIds?: string[];
}

export interface GondolinSecretConfig {
	value: string;
	hosts: string[];
}

export interface GondolinConfig {
	secrets?: Record<string, GondolinSecretConfig>;
}

export interface ConfiguredChannel {
	runtime?: RuntimeConfig;
	id: string;
	name?: string;
	dm?: boolean;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
}

export interface BaseAccountConfig {
	runtime?: RuntimeConfig;
	service: ChatService;
	name?: string;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
	channels: Record<string, ConfiguredChannel>;
}

export interface TelegramAccountConfig extends BaseAccountConfig {
	service: "telegram";
	botToken: string;
	botUsername?: string;
	botUserId?: string;
}

export interface DiscordAccountConfig extends BaseAccountConfig {
	service: "discord";
	botToken: string;
	applicationId: string;
	serverId: string;
	serverName: string;
	botUserId?: string;
	botUsername?: string;
}

/** How a Feishu/Lark app receives events. Omitted means HTTP, so old configs stay compatible. */
export type FeishuEventMode = "websocket" | "http";

/** Account-level Feishu status reactions. `false` disables them; omitted means enabled. */
export interface FeishuReactionSettings {
	enabled?: boolean;
	/** Emoji added while a turn is running. Default `Typing`. */
	inProgress?: string;
	/** Emoji added only after `Typing` was removed and the turn failed. Default `CrossMark`. */
	failure?: string;
}

/** Optional long-connection health thresholds. Omitted fields use the defaults in `resolveFeishuWsHealth`. */
export interface FeishuWebSocketHealthConfig {
	/** How often to compare last inbound activity with `staleTimeoutMs`. Default 15000. */
	healthCheckIntervalMs?: number;
	/**
	 * No inbound frame, pong, or event for this long means the socket is dead.
	 * Default 300000. Must exceed the platform ping interval (SDK default 120s) or a healthy idle link is rebuilt.
	 */
	staleTimeoutMs?: number;
	/** First reconnect delay. Later attempts double until `reconnectMaxDelayMs`. Default 1000. */
	reconnectMinDelayMs?: number;
	/** Cap for exponential reconnect backoff, including jitter. Default 60000. */
	reconnectMaxDelayMs?: number;
}

export interface FeishuAccountConfig extends BaseAccountConfig {
	service: "feishu";
	appId: string;
	appSecret: string;
	domain?: "feishu" | "lark";
	/** WebSocket liveness and reconnect backoff. Ignored in HTTP callback mode. */
	websocket?: FeishuWebSocketHealthConfig;
	/**
	 * Status reactions on the triggering message. Default enabled.
	 * `false` or `{ enabled: false }` turns them off for this account.
	 * `FEISHU_REACTIONS=false|0|no|off` disables them for the process.
	 */
	reactions?: boolean | FeishuReactionSettings;
	/**
	 * `websocket` uses the official SDK long connection and needs no public callback URL.
	 * Missing means `http` so existing callback deployments keep working. New setup UI accounts set `websocket` explicitly.
	 */
	eventMode?: FeishuEventMode;
	/** Required for HTTP callbacks. Unused by WebSocket receive; may be omitted. */
	verificationToken?: string;
	encryptKey?: string;
	webhook?: { host?: string; port?: number; path?: string };
	botUserId?: string;
	botUsername?: string;
}

export type ChatAccountConfig = TelegramAccountConfig | DiscordAccountConfig | FeishuAccountConfig;

export interface ChatConfig {
	runtime?: RuntimeConfig;
	botName?: string;
	gondolin?: GondolinConfig;
	accounts: Record<string, ChatAccountConfig>;
}

export interface ResolvedConversation {
	runtimeMode: "gondolin" | "local" | "docker";
	docker?: DockerSettings;
	dockerDir?: string;
	workspacePath: string;
	sharedPath: string;
	service: ChatService;
	botName: string;
	accountId: string;
	account: ChatAccountConfig;
	channelKey: string;
	channel: ConfiguredChannel;
	conversationId: string;
	conversationName: string;
	access: AccessPolicy;
	gondolinSecrets: Record<string, GondolinSecretConfig>;
	accountDir: string;
	sharedDir: string;
	conversationDir: string;
	workspaceDir: string;
	gondolinDir: string;
	accountMemoryPath: string;
	channelMemoryPath: string;
	logPath: string;
	filesDir: string;
	lockPath: string;
}
