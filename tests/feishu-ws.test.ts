import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
	attachFeishuWsActivityHooks,
	DEFAULT_FEISHU_WS_HEALTH,
	type FeishuWsHooks,
	FeishuWsSupervisor,
	feishuPingExceedsStale,
	feishuReconnectDelayMs,
	formatFeishuConnectionStatus,
	formatFeishuWorkerSuffix,
	formatFeishuWsLog,
	readFeishuSdkPingIntervalMs,
	resolveFeishuWsHealth,
} from "../src/live/feishu-ws.js";

const fastHealth = {
	healthCheckIntervalMs: 10,
	staleTimeoutMs: 50,
	reconnectMinDelayMs: 1_000,
	reconnectMaxDelayMs: 8_000,
};

async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("Feishu websocket health config uses defaults and rejects invalid thresholds", () => {
	assert.deepEqual(resolveFeishuWsHealth(undefined), { ...DEFAULT_FEISHU_WS_HEALTH });
	assert.equal(resolveFeishuWsHealth({ staleTimeoutMs: 180_000 }).staleTimeoutMs, 180_000);
	assert.equal(resolveFeishuWsHealth({ healthCheckIntervalMs: 5_000 }).reconnectMaxDelayMs, 60_000);
	assert.throws(() => resolveFeishuWsHealth([]), /must be an object/);
	assert.throws(() => resolveFeishuWsHealth({ staleTimeoutMs: 0 }), /staleTimeoutMs/);
	assert.throws(() => resolveFeishuWsHealth({ reconnectMinDelayMs: 1.5 }), /reconnectMinDelayMs/);
	assert.throws(
		() => resolveFeishuWsHealth({ reconnectMinDelayMs: 5_000, reconnectMaxDelayMs: 1_000 }),
		/reconnectMinDelayMs must be <= reconnectMaxDelayMs/,
	);
});

test("Feishu reconnect delay doubles with jitter and stays within the cap", () => {
	const health = { reconnectMinDelayMs: 1_000, reconnectMaxDelayMs: 8_000 };
	assert.equal(
		feishuReconnectDelayMs(1, health, () => 1),
		1_000,
	);
	assert.equal(
		feishuReconnectDelayMs(1, health, () => 0),
		750,
	);
	assert.equal(
		feishuReconnectDelayMs(2, health, () => 1),
		2_000,
	);
	assert.equal(
		feishuReconnectDelayMs(3, health, () => 1),
		4_000,
	);
	assert.equal(
		feishuReconnectDelayMs(4, health, () => 1),
		8_000,
	);
	assert.equal(
		feishuReconnectDelayMs(10, health, () => 1),
		8_000,
	);
	assert.equal(
		feishuReconnectDelayMs(10, health, () => 0),
		6_000,
	);
	assert.equal(
		feishuReconnectDelayMs(0, health, () => 1),
		1_000,
	);
	const mid = feishuReconnectDelayMs(3, health, () => 0.5);
	assert.ok(mid >= 3_000 && mid <= 4_000);
});

test("Feishu status text includes link state, last activity, and reconnect count", () => {
	const text = formatFeishuConnectionStatus({
		state: "reconnecting",
		lastActivityAt: "2026-04-08T19:45:00.000Z",
		reconnectCount: 2,
		lastDisconnectReason: "socket close",
	});
	assert.match(text, /Feishu WS: reconnecting/);
	assert.match(text, /Feishu WS activity: 2026-04-08T19:45:00.000Z/);
	assert.match(text, /Feishu WS reconnects: 2/);
	assert.equal(formatFeishuWorkerSuffix({ state: "stale", reconnectCount: 4 }), ", ws:stale reconnects:4");
	assert.equal(formatFeishuWorkerSuffix(undefined), "");
	assert.equal(feishuPingExceedsStale(120_000, 120_000), true);
	assert.equal(feishuPingExceedsStale(119_999, 120_000), false);
	assert.equal(readFeishuSdkPingIntervalMs({ wsConfig: { getWS: () => ({ pingInterval: 120_000 }) } }), 120_000);
});

test("Feishu socket instrumentation treats inbound frames as activity and close or error as link down", () => {
	const socket = new EventEmitter() as EventEmitter & { readyState: number; close: () => void };
	socket.readyState = 1;
	let closed = 0;
	socket.close = () => {
		closed++;
	};
	const kinds: string[] = [];
	const downs: string[] = [];
	const client = {
		wsConfig: { getWSInstance: () => socket },
		communicate() {
			socket.readyState = 1;
		},
	};
	const attached = attachFeishuWsActivityHooks(client, {
		onActivity: (kind) => kinds.push(kind),
		onLinkDown: (reason) => downs.push(reason),
	});
	assert.equal(attached.instrumented, true);
	client.communicate();
	client.communicate();
	socket.emit("message", Buffer.from("pong-frame"));
	socket.emit("pong");
	socket.emit("error", new Error("reset"));
	socket.emit("close");
	attached.releaseSocket();
	assert.deepEqual(kinds, ["frame", "pong"]);
	assert.deepEqual(downs, ["socket error: reset", "socket close"]);
	assert.equal(closed, 1);
	assert.equal(attachFeishuWsActivityHooks({}, {}).instrumented, false);
});

test("Feishu websocket supervisor rebuilds on stale or close, backs off, and stops when closed", async () => {
	const logs: string[] = [];
	const delays: number[] = [];
	let now = 1_000;
	let failuresLeft = 0;
	let hooks: FeishuWsHooks = {};
	let starts = 0;
	const closed: number[] = [];
	const supervisor = new FeishuWsSupervisor({
		health: fastHealth,
		now: () => now,
		random: () => 1,
		sleep: async (ms) => {
			delays.push(ms);
		},
		schedule: () => ({ stop() {} }),
		log: (line) => logs.push(line),
		createSession: (next) => {
			hooks = next;
			const id = starts++;
			return {
				async start() {
					if (failuresLeft > 0) {
						failuresLeft--;
						throw new Error("pull failed");
					}
				},
				close() {
					closed.push(id);
				},
				socketState: () => "open" as const,
				pingIntervalMs: () => 120_000,
			};
		},
	});
	await supervisor.start({});
	assert.equal(supervisor.status().state, "connected");
	assert.equal(supervisor.status().reconnectCount, 0);
	assert.equal(supervisor.status().lastActivityAt, new Date(1_000).toISOString());

	now += 50;
	supervisor.checkHealth();
	assert.equal(starts, 1);
	now += 1;
	supervisor.checkHealth();
	supervisor.checkHealth();
	await drain();
	assert.equal(starts, 2);
	assert.deepEqual(closed, [0]);
	assert.equal(supervisor.status().state, "connected");
	assert.equal(supervisor.status().reconnectCount, 1);
	assert.match(logs.join("\n"), /WebSocket stale: no activity for 51ms/);
	assert.match(logs.join("\n"), /WebSocket reconnected/);

	failuresLeft = 2;
	hooks.onLinkDown?.("socket close");
	hooks.onLinkDown?.("socket close");
	await drain();
	assert.deepEqual(delays.slice(-3), [1_000, 2_000, 4_000]);
	assert.equal(supervisor.status().reconnectCount, 4);
	assert.equal(supervisor.status().state, "connected");
	assert.equal(supervisor.status().lastDisconnectReason, "socket close");
	assert.match(
		formatFeishuWsLog({ type: "disconnected", message: logs.at(-1) ?? "", at: "", status: supervisor.status() }),
		/reconnects=/,
	);

	const before = starts;
	let release: () => void = () => {};
	const waiting = new FeishuWsSupervisor({
		health: fastHealth,
		sleep: (_ms, signal) =>
			new Promise((resolve) => {
				release = resolve;
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
		schedule: () => ({ stop() {} }),
		log: () => {},
		createSession: (next) => {
			hooks = next;
			return {
				async start() {
					starts++;
				},
				close() {},
			};
		},
	});
	await waiting.start({});
	hooks.onLinkDown?.("socket close");
	await drain();
	waiting.close();
	release();
	await drain();
	assert.equal(starts, before + 1);
	assert.equal(waiting.status().state, "closed");
});

test("Feishu websocket supervisor logs connect and close to stderr", async () => {
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		const supervisor = new FeishuWsSupervisor({
			health: DEFAULT_FEISHU_WS_HEALTH,
			schedule: () => ({ stop() {} }),
			createSession: () => ({
				async start() {},
				close() {},
				pingIntervalMs: () => 400_000,
			}),
		});
		await supervisor.start({});
		supervisor.checkHealth();
		supervisor.close();
	} finally {
		console.error = original;
	}
	const text = lines.join("\n");
	assert.match(text, /\[pi-chat feishu\] WebSocket connecting/);
	assert.match(text, /WebSocket connected/);
	assert.match(text, /WebSocket closed/);
	assert.match(text, /server ping interval 400000ms/);
});
