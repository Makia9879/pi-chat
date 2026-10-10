import type { FeishuAccountConfig } from "../core/config-types.js";
import type { DiscoveryProvider } from "./types.js";

export type FeishuCredentials = Pick<FeishuAccountConfig, "appId" | "appSecret" | "domain">;

/** Small REST client for self-built Feishu/Lark apps (tenant credentials). */
export class FeishuClient {
	private token?: { value: string; expires: number };
	private refreshing?: Promise<string>;
	readonly baseUrl: string;

	constructor(private credentials: FeishuCredentials) {
		if (!credentials.appId?.trim() || !credentials.appSecret?.trim())
			throw new Error("Feishu App ID and App Secret are required");
		if (credentials.domain && !["feishu", "lark"].includes(credentials.domain))
			throw new Error("Invalid Feishu domain");
		this.baseUrl =
			credentials.domain === "lark" ? "https://open.larksuite.com/open-apis" : "https://open.feishu.cn/open-apis";
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expires > Date.now()) return this.token.value;
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			const response = await fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
				signal: AbortSignal.timeout(15000),
			});
			const result = (await response.json()) as { code?: number; tenant_access_token?: string; expire?: number };
			if (!response.ok || result.code !== 0 || !result.tenant_access_token)
				throw new Error(`Feishu authentication failed (${result.code ?? response.status})`);
			this.token = {
				value: result.tenant_access_token,
				expires: Date.now() + Math.max(0, (result.expire ?? 7200) - 60) * 1000,
			};
			return this.token.value;
		})();
		try {
			return await this.refreshing;
		} finally {
			this.refreshing = undefined;
		}
	}

	async request<T>(
		path: string,
		body?: Record<string, unknown> | FormData,
		signal?: AbortSignal,
		retry = true,
		method?: "GET" | "POST" | "DELETE",
	): Promise<T> {
		signal?.throwIfAborted();
		const httpMethod = method ?? (body ? "POST" : "GET");
		const token = await this.accessToken();
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: httpMethod,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body instanceof FormData || httpMethod === "DELETE" ? {} : { "content-type": "application/json" }),
			},
			body: httpMethod === "DELETE" || !body ? undefined : body instanceof FormData ? body : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
		});
		const raw = await response.text();
		let result: T & { code?: number; msg?: string };
		try {
			result = (raw ? JSON.parse(raw) : {}) as T & { code?: number; msg?: string };
		} catch {
			if (retry && httpMethod === "GET" && (response.status === 429 || response.status >= 500))
				return this.request<T>(path, body, signal, false, httpMethod);
			throw new Error(`Feishu API ${path.split("?")[0]} failed (${response.status}): invalid JSON`);
		}
		if (retry && [99991663, 99991664, 99991665].includes(result.code ?? 0)) {
			this.token = undefined;
			return this.request<T>(path, body, signal, false, httpMethod);
		}
		// Retry idempotent reads only. Message sends and reaction writes stay single-attempt.
		if (
			retry &&
			httpMethod === "GET" &&
			(response.status === 429 || response.status >= 500 || (result.code ?? 0) >= 500)
		)
			return this.request<T>(path, body, signal, false, httpMethod);
		if (!response.ok || result.code !== 0)
			throw new Error(
				`Feishu API ${path.split("?")[0]} failed (${result.code ?? response.status}): ${result.msg ?? "unknown error"}`,
			);
		return result;
	}

	async identity() {
		const result = await this.request<{ bot?: { open_id?: string; app_name?: string } }>("/bot/v3/info");
		if (!result.bot?.open_id)
			throw new Error("Feishu app has no bot identity. Enable the Bot capability and publish the app.");
		return {
			id: result.bot.open_id,
			name: result.bot.app_name ?? this.credentials.appId,
			userName: result.bot.app_name,
		};
	}
}

export const feishuDiscoveryProvider: DiscoveryProvider = {
	service: "feishu",
	async validate(draft) {
		if (draft.service !== "feishu") throw new Error("Expected Feishu credentials");
		return { identity: await new FeishuClient(draft).identity() };
	},
	async fetchSnapshot(accountId, account) {
		if (account.service !== "feishu") throw new Error("Expected Feishu account");
		return {
			accountId,
			service: "feishu",
			fetchedAt: new Date().toISOString(),
			identity: await new FeishuClient(account).identity(),
			channels: Object.values(account.channels).map((channel) => ({
				id: channel.id,
				name: channel.name ?? channel.id,
				dm: channel.dm,
			})),
			users: [],
			roles: [],
			capabilities: { canListChannels: false, canListUsers: false, canListRoles: false },
			warnings: ["Add channels by chat_id (oc_...). Use open_id (ou_...) for allowed users."],
		};
	},
};
