/**
 * Feishu long-connection health supervisor.
 *
 * `@larksuiteoapi/node-sdk` 1.74 `WSClient` treats a socket as alive until it
 * emits `close` or `error`. A half-open TCP path does neither, and the SDK
 * pong watchdog is disabled unless `pingTimeout` is set. This module records
 * inbound activity and replaces the client when the socket closes or goes
 * quiet. The full SDK trace is in docs/DEVELOPMENT.md.
 */

export const DEFAULT_FEISHU_WS_HEALTH = {
	healthCheckIntervalMs: 15_000,
	staleTimeoutMs: 300_000,
	reconnectMinDelayMs: 1_000,
	reconnectMaxDelayMs: 60_000,
} as const;

/**
 * Seconds. Secondary SDK watchdog: terminate the socket if no inbound frame
 * arrives within this window after a ping. Must stay below the default 120s
 * ping or the next ping resets the timer and it never fires. The supervisor
 * stale timeout is the backstop when no ping is in flight.
 */
export const FEISHU_SDK_PING_TIMEOUT_SEC = 45;

export interface FeishuWsHealthConfig {
	healthCheckIntervalMs: number;
	staleTimeoutMs: number;
	reconnectMinDelayMs: number;
	reconnectMaxDelayMs: number;
}

export type FeishuWsLinkState = "connecting" | "connected" | "stale" | "disconnected" | "reconnecting" | "closed";

export type FeishuWsLinkEventType =
	| "connecting"
	| "connected"
	| "disconnected"
	| "stale"
	| "reconnecting"
	| "reconnected"
	| "closed";

export interface FeishuWsLinkStatus {
	state: FeishuWsLinkState;
	lastActivityAt?: string;
	lastActivityKind?: string;
	reconnectCount: number;
	nextReconnectAt?: string;
	lastDisconnectReason?: string;
	lastError?: string;
}

export interface FeishuWsLinkEvent {
	type: FeishuWsLinkEventType;
	message: string;
	at: string;
	status: FeishuWsLinkStatus;
}

export interface FeishuWsHooks {
	onTerminalError?: (error: Error) => void;
	onActivity?: (kind: string) => void;
	onLinkDown?: (reason: string) => void;
}

export interface FeishuWsSession {
	start(dispatcher: unknown): Promise<void>;
	close(): void;
	/** `closed` means the SDK no longer has an open socket. Half-open still reports `open`. */
	socketState?: () => "open" | "closed" | "unknown";
	pingIntervalMs?: () => number | undefined;
}

export interface FeishuWsSchedule {
	stop(): void;
}

export interface FeishuWsSupervisorOptions {
	health: FeishuWsHealthConfig;
	createSession: (hooks: FeishuWsHooks) => FeishuWsSession;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	random?: () => number;
	schedule?: (fn: () => void, ms: number) => FeishuWsSchedule;
	log?: (line: string) => void;
	onEvent?: (event: FeishuWsLinkEvent) => void;
}

export interface FeishuWorkerStatusFields {
	state: string;
	lastActivityAt?: string;
	reconnectCount: number;
	nextReconnectAt?: string;
	lastDisconnectReason?: string;
}

interface MinimalSocket {
	readyState?: number;
	close?: () => void;
	on?: (event: string, listener: (...args: unknown[]) => void) => void;
	__piChatInstrumented?: boolean;
}

export function resolveFeishuWsHealth(raw: unknown): FeishuWsHealthConfig {
	if (raw === undefined || raw === null) return { ...DEFAULT_FEISHU_WS_HEALTH };
	if (typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Feishu websocket health config must be an object");
	const record = raw as Record<string, unknown>;
	const health: FeishuWsHealthConfig = {
		healthCheckIntervalMs: readPositiveInt(
			record,
			"healthCheckIntervalMs",
			DEFAULT_FEISHU_WS_HEALTH.healthCheckIntervalMs,
		),
		staleTimeoutMs: readPositiveInt(record, "staleTimeoutMs", DEFAULT_FEISHU_WS_HEALTH.staleTimeoutMs),
		reconnectMinDelayMs: readPositiveInt(record, "reconnectMinDelayMs", DEFAULT_FEISHU_WS_HEALTH.reconnectMinDelayMs),
		reconnectMaxDelayMs: readPositiveInt(record, "reconnectMaxDelayMs", DEFAULT_FEISHU_WS_HEALTH.reconnectMaxDelayMs),
	};
	if (health.reconnectMinDelayMs > health.reconnectMaxDelayMs) {
		throw new Error("Feishu websocket.reconnectMinDelayMs must be <= reconnectMaxDelayMs");
	}
	return health;
}

function readPositiveInt(record: Record<string, unknown>, name: string, fallback: number): number {
	const value = record[name];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`Feishu websocket.${name} must be a positive integer`);
	}
	return value;
}

/**
 * 1-based attempt. Delay is `min(max, min * 2^(attempt-1))`, then multiplied by
 * `0.75 + 0.25 * random()` so jitter stays inside the configured ceiling.
 */
export function feishuReconnectDelayMs(
	attempt: number,
	health: Pick<FeishuWsHealthConfig, "reconnectMinDelayMs" | "reconnectMaxDelayMs">,
	random: () => number = Math.random,
): number {
	const n = Math.max(1, Math.floor(attempt));
	const exponent = Math.min(n - 1, 16);
	const ceiling = Math.min(health.reconnectMaxDelayMs, health.reconnectMinDelayMs * 2 ** exponent);
	const unit = Math.min(1, Math.max(0, random()));
	return Math.min(health.reconnectMaxDelayMs, Math.max(1, Math.floor(ceiling * (0.75 + 0.25 * unit))));
}

export function feishuPingExceedsStale(pingIntervalMs: number | undefined, staleTimeoutMs: number): boolean {
	return typeof pingIntervalMs === "number" && Number.isFinite(pingIntervalMs) && pingIntervalMs >= staleTimeoutMs;
}

export function readFeishuSdkPingIntervalMs(client: object): number | undefined {
	const wsConfig = (client as { wsConfig?: { getWS?: (key?: string) => unknown } }).wsConfig;
	const ws = wsConfig?.getWS?.();
	if (!ws || typeof ws !== "object" || !("pingInterval" in ws)) return undefined;
	const ping = (ws as { pingInterval?: unknown }).pingInterval;
	return typeof ping === "number" && Number.isFinite(ping) && ping > 0 ? ping : undefined;
}

export function attachFeishuWsActivityHooks(
	client: object,
	hooks: FeishuWsHooks,
): { instrumented: boolean; releaseSocket: () => void } {
	let socket: MinimalSocket | undefined;
	const target = client as {
		communicate?: () => void;
		wsConfig?: { getWSInstance?: () => MinimalSocket | null | undefined };
	};
	const original = target.communicate?.bind(target);
	if (!original) {
		return {
			instrumented: false,
			releaseSocket() {
				return undefined;
			},
		};
	}
	target.communicate = () => {
		original();
		const next = target.wsConfig?.getWSInstance?.() ?? undefined;
		if (!next) return;
		socket = next;
		if (next.__piChatInstrumented) return;
		next.__piChatInstrumented = true;
		next.on?.("message", () => hooks.onActivity?.("frame"));
		next.on?.("pong", () => hooks.onActivity?.("pong"));
		next.on?.("close", () => hooks.onLinkDown?.("socket close"));
		next.on?.("error", (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error ?? "socket error");
			hooks.onLinkDown?.(`socket error: ${message}`);
		});
	};
	return {
		instrumented: true,
		releaseSocket() {
			try {
				if (socket?.readyState === 1) socket.close?.();
			} catch {
				// A dead peer may reject the close frame. The caller still force-closes.
			}
		},
	};
}

export function formatFeishuWsLog(event: FeishuWsLinkEvent): string {
	const activity = event.status.lastActivityAt ?? "never";
	return `[pi-chat feishu] ${event.message} (state=${event.status.state}, reconnects=${event.status.reconnectCount}, lastActivity=${activity})`;
}

export function defaultFeishuWsLog(line: string): void {
	console.error(line);
}

export function formatFeishuConnectionStatus(status: {
	state: string;
	lastActivityAt?: string;
	reconnectCount: number;
	lastDisconnectReason?: string;
	nextReconnectAt?: string;
}): string {
	const lines = [
		`Feishu WS: ${status.state}`,
		`Feishu WS activity: ${status.lastActivityAt ?? "never"}`,
		`Feishu WS reconnects: ${status.reconnectCount}`,
	];
	if (status.lastDisconnectReason) lines.push(`Feishu WS last disconnect: ${status.lastDisconnectReason}`);
	if (status.nextReconnectAt) lines.push(`Feishu WS next reconnect: ${status.nextReconnectAt}`);
	return lines.join("\n");
}

export function feishuWorkerStatusFields(status: {
	state: string;
	lastActivityAt?: string;
	reconnectCount: number;
	nextReconnectAt?: string;
	lastDisconnectReason?: string;
}): FeishuWorkerStatusFields {
	return {
		state: status.state,
		lastActivityAt: status.lastActivityAt,
		reconnectCount: status.reconnectCount,
		nextReconnectAt: status.nextReconnectAt,
		lastDisconnectReason: status.lastDisconnectReason,
	};
}

export function formatFeishuWorkerSuffix(fields: { state: string; reconnectCount: number } | undefined): string {
	if (!fields) return "";
	return `, ws:${fields.state} reconnects:${fields.reconnectCount}`;
}

function defaultSchedule(fn: () => void, ms: number): FeishuWsSchedule {
	const timer = setInterval(fn, ms);
	if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
	return { stop: () => clearInterval(timer) };
}

export class FeishuWsSupervisor {
	private stopped = false;
	private opened = false;
	private opening = false;
	private rebuilding = false;
	private warnedLongPing = false;
	private generation = 0;
	private attempt = 0;
	private reconnectCount = 0;
	private state: FeishuWsLinkState = "connecting";
	private lastActivityAt: number | undefined;
	private lastActivityKind: string | undefined;
	private nextReconnectAt: number | undefined;
	private lastDisconnectReason: string | undefined;
	private lastError: string | undefined;
	private downDuringOpen: string | undefined;
	private dispatcher: unknown;
	private session: FeishuWsSession | undefined;
	private timer: FeishuWsSchedule | undefined;
	private readonly abort = new AbortController();

	constructor(private readonly options: FeishuWsSupervisorOptions) {}

	async start(dispatcher: unknown): Promise<void> {
		this.dispatcher = dispatcher;
		this.state = "connecting";
		this.emit("connecting", "WebSocket connecting");
		await this.open(dispatcher);
		if (this.stopped) throw new Error("Feishu WebSocket closed");
		this.opened = true;
		this.state = "connected";
		this.noteActivity("ready");
		this.emit("connected", "WebSocket connected");
		this.armTimer();
	}

	close(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.state = "closed";
		this.nextReconnectAt = undefined;
		this.abort.abort();
		this.timer?.stop();
		this.timer = undefined;
		const session = this.session;
		this.session = undefined;
		try {
			session?.close();
		} catch {
			// Already torn down.
		}
		this.emit("closed", "WebSocket closed");
	}

	status(): FeishuWsLinkStatus {
		return {
			state: this.state,
			lastActivityAt: this.lastActivityAt === undefined ? undefined : new Date(this.lastActivityAt).toISOString(),
			lastActivityKind: this.lastActivityKind,
			reconnectCount: this.reconnectCount,
			nextReconnectAt: this.nextReconnectAt === undefined ? undefined : new Date(this.nextReconnectAt).toISOString(),
			lastDisconnectReason: this.lastDisconnectReason,
			lastError: this.lastError,
		};
	}

	/** Inbound frame, pong, or dispatched event. Outbound ping success is not activity. */
	noteActivity(kind: string): void {
		if (this.stopped) return;
		this.lastActivityAt = this.now();
		this.lastActivityKind = kind;
	}

	checkHealth(): void {
		if (this.stopped || !this.opened || this.rebuilding || this.opening || this.state !== "connected") return;
		this.warnIfPingTooSlow();
		if (this.session?.socketState?.() === "closed") {
			this.requestRebuild("socket not open");
			return;
		}
		if (this.lastActivityAt === undefined) return;
		const idle = this.now() - this.lastActivityAt;
		if (idle > this.options.health.staleTimeoutMs) {
			this.requestRebuild(`no activity for ${idle}ms (limit ${this.options.health.staleTimeoutMs}ms)`);
		}
	}

	private warnIfPingTooSlow(): void {
		if (this.warnedLongPing) return;
		const ping = this.session?.pingIntervalMs?.();
		if (!feishuPingExceedsStale(ping, this.options.health.staleTimeoutMs)) return;
		this.warnedLongPing = true;
		this.writeLog(
			`[pi-chat feishu] server ping interval ${ping}ms is >= websocket.staleTimeoutMs ${this.options.health.staleTimeoutMs}ms; a healthy idle connection can be treated as stale. Raise staleTimeoutMs above the platform ping interval.`,
		);
	}

	private requestRebuild(reason: string): void {
		if (this.stopped || !this.opened || this.rebuilding) return;
		this.rebuilding = true;
		const generation = ++this.generation;
		void this.rebuild(reason, generation).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.writeLog(`[pi-chat feishu] WebSocket supervisor failed: ${message}`);
			if (generation === this.generation) this.rebuilding = false;
		});
	}

	private async rebuild(reason: string, generation: number): Promise<void> {
		let why = reason;
		try {
			while (!this.stopped && generation === this.generation) {
				this.reconnectCount += 1;
				this.attempt += 1;
				if (this.attempt === 1) this.lastDisconnectReason = why;
				const stale = why.startsWith("no activity");
				this.state = stale ? "stale" : "disconnected";
				this.emit(
					stale ? "stale" : "disconnected",
					stale ? `WebSocket stale: ${why}` : `WebSocket disconnected: ${why}`,
				);
				try {
					this.session?.close();
				} catch {
					// The socket may already be gone.
				}
				this.session = undefined;
				const delay = feishuReconnectDelayMs(this.attempt, this.options.health, this.options.random ?? Math.random);
				this.nextReconnectAt = this.now() + delay;
				this.state = "reconnecting";
				this.emit("reconnecting", `WebSocket reconnecting in ${delay}ms (attempt ${this.attempt})`);
				await this.sleep(delay);
				if (this.stopped || generation !== this.generation) return;
				try {
					await this.open(this.dispatcher);
					if (this.stopped || generation !== this.generation) return;
					this.attempt = 0;
					this.nextReconnectAt = undefined;
					this.lastError = undefined;
					this.state = "connected";
					this.noteActivity("ready");
					this.emit("reconnected", "WebSocket reconnected");
					return;
				} catch (error) {
					if (this.stopped || generation !== this.generation) return;
					const message = error instanceof Error ? error.message : String(error);
					this.lastError = message;
					why = `reconnect failed: ${message}`;
					this.state = "reconnecting";
					this.emit("reconnecting", `WebSocket reconnect failed: ${message}`);
				}
			}
		} finally {
			if (generation === this.generation) this.rebuilding = false;
		}
	}

	private async open(dispatcher: unknown): Promise<void> {
		this.opening = true;
		this.downDuringOpen = undefined;
		try {
			const session = this.options.createSession(this.sessionHooks());
			this.session = session;
			try {
				await session.start(dispatcher);
				if (this.stopped) throw new Error("Feishu WebSocket closed");
				if (this.downDuringOpen) throw new Error(this.downDuringOpen);
			} catch (error) {
				try {
					session.close();
				} catch {
					// Already closed by the failed handshake.
				}
				if (this.session === session) this.session = undefined;
				throw error;
			}
		} finally {
			this.opening = false;
		}
	}

	private sessionHooks(): FeishuWsHooks {
		return {
			onActivity: (kind) => this.noteActivity(kind),
			onLinkDown: (reason) => this.onLinkDown(reason),
		};
	}

	private onLinkDown(reason: string): void {
		if (this.stopped) return;
		if (this.opening) {
			this.downDuringOpen = reason;
			return;
		}
		this.requestRebuild(reason);
	}

	private armTimer(): void {
		this.timer?.stop();
		const schedule = this.options.schedule ?? defaultSchedule;
		this.timer = schedule(() => this.checkHealth(), this.options.health.healthCheckIntervalMs);
	}

	private sleep(ms: number): Promise<void> {
		const signal = this.abort.signal;
		if (signal.aborted) return Promise.resolve();
		if (this.options.sleep) return this.options.sleep(ms, signal);
		return new Promise((resolve) => {
			const timer = setTimeout(finish, ms);
			const onAbort = () => finish();
			signal.addEventListener("abort", onAbort, { once: true });
			function finish() {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				resolve();
			}
		});
	}

	private emit(type: FeishuWsLinkEventType, message: string): void {
		const event: FeishuWsLinkEvent = {
			type,
			message,
			at: new Date(this.now()).toISOString(),
			status: this.status(),
		};
		this.writeLog(formatFeishuWsLog(event));
		try {
			this.options.onEvent?.(event);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.writeLog(`[pi-chat feishu] connection event callback failed: ${text}`);
		}
	}

	private writeLog(line: string): void {
		try {
			(this.options.log ?? defaultFeishuWsLog)(line);
		} catch {
			// Logging must not break reconnect.
		}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}
