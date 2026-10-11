import { request } from "node:http";
import type { Duplex } from "node:stream";

export class DockerError extends Error {
	constructor(
		readonly status: number,
		readonly operation: string,
	) {
		super(`Docker ${operation} failed (${status}); inspect daemon availability and managed resource state`);
	}
}
export interface DockerClient {
	json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T>;
	exec(
		id: string,
		input: Buffer | undefined,
		onData: (data: Buffer, stream: number) => void,
		signal: AbortSignal,
	): Promise<void>;
}

/** Incremental non-TTY Engine framing. Bounds apply before allocating a frame. */
export class DockerFrames {
	private pending = Buffer.alloc(0);
	private remaining = 0;
	private stream = 0;
	constructor(
		private readonly onData: (data: Buffer, stream: number) => void,
		private readonly maxFrame = 16 * 1024 * 1024,
	) {}
	push(chunk: Buffer): void {
		while (chunk.length) {
			if (!this.remaining) {
				const take = Math.min(8 - this.pending.length, chunk.length);
				this.pending = Buffer.concat([this.pending, chunk.subarray(0, take)]);
				chunk = chunk.subarray(take);
				if (this.pending.length < 8) return;
				this.stream = this.pending[0];
				this.remaining = this.pending.readUInt32BE(4);
				if (
					![1, 2].includes(this.stream) ||
					this.pending.subarray(1, 4).some((x) => x !== 0) ||
					this.remaining > this.maxFrame
				)
					throw new Error("Docker invalid output frame");
				this.pending = Buffer.alloc(0);
			}
			const take = Math.min(this.remaining, chunk.length);
			if (take) this.onData(chunk.subarray(0, take), this.stream);
			this.remaining -= take;
			chunk = chunk.subarray(take);
		}
	}
	end(): void {
		if (this.remaining || this.pending.length) throw new Error("Docker truncated output stream");
	}
}

/** Fixed local socket: deliberately ignores DOCKER_HOST/CONTEXT and inherited credentials. */
export class EngineClient implements DockerClient {
	private version = "";
	constructor(private readonly socketPath = "/var/run/docker.sock") {
		if (!socketPath.startsWith("/")) throw new Error("Docker requires an approved local Unix socket");
	}
	async negotiate(): Promise<void> {
		const version = await this.json<{ ApiVersion: string; MinAPIVersion: string }>("GET", "/version");
		const max = Number(version.ApiVersion.split(".")[1]);
		const min = Number(version.MinAPIVersion.split(".")[1]);
		if (max < 44 || min > 45) throw new Error("Docker requires Engine API 1.44–1.45 compatibility");
		this.version = `/v1.${Math.min(45, max)}`;
	}
	json<T>(method: string, path: string, body?: unknown, timeoutMs = 10000): Promise<T> {
		return new Promise((resolve, reject) => {
			const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const req = request(
				{
					socketPath: this.socketPath,
					path: this.version + path,
					method,
					headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) },
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > 4 * 1024 * 1024) req.destroy(new Error("Docker JSON response limit"));
						else chunks.push(chunk);
					});
					res.on("error", () => reject(new DockerError(0, method)));
					res.on("end", () => {
						clearTimeout(timer);
						if (!res.statusCode || res.statusCode >= 300) return reject(new DockerError(res.statusCode ?? 0, method));
						try {
							const text = Buffer.concat(chunks).toString();
							if (path.startsWith("/images/create?")) {
								for (const line of text.split("\n").filter(Boolean))
									if (JSON.parse(line).error) throw new Error("Docker pull failed");
								resolve(undefined as T);
							} else resolve((text ? JSON.parse(text) : undefined) as T);
						} catch {
							reject(new Error("Docker invalid JSON response"));
						}
					});
				},
			);
			const timer = setTimeout(() => req.destroy(new Error("Docker control deadline exceeded")), timeoutMs);
			req.on("error", () => {
				clearTimeout(timer);
				reject(new DockerError(0, method));
			});
			req.end(data);
		});
	}
	exec(
		id: string,
		input: Buffer | undefined,
		onData: (data: Buffer, stream: number) => void,
		signal: AbortSignal,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new Error("aborted"));
			let socket: Duplex | undefined;
			let settled = false;
			const parser = new DockerFrames(onData);
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				socket?.destroy();
				req.destroy();
				if (error) reject(error);
				else resolve();
			};
			const abort = () => finish(new Error("aborted"));
			const req = request({
				socketPath: this.socketPath,
				path: `${this.version}/exec/${encodeURIComponent(id)}/start`,
				method: "POST",
				headers: { "Content-Type": "application/json", Connection: "Upgrade", Upgrade: "tcp" },
			});
			const timer = setTimeout(() => finish(new Error("Docker exec attach deadline")), 10000);
			const attach = (stream: Duplex, head?: Buffer) => {
				clearTimeout(timer);
				socket = stream;
				stream.on("data", (chunk: Buffer) => {
					try {
						parser.push(chunk);
					} catch {
						finish(new Error("Docker output transport or callback failed"));
					}
				});
				stream.on("error", () => finish(new Error("Docker exec transport lost; outcome unknown")));
				stream.on("end", () => {
					try {
						parser.end();
						finish();
					} catch {
						finish(new Error("Docker truncated output"));
					}
				});
				if (head?.length) {
					try {
						parser.push(head);
					} catch {
						finish(new Error("Docker invalid output"));
					}
				}
				if (input !== undefined) stream.end(input);
			};
			req.on("upgrade", (_res, stream, head) => attach(stream, head));
			req.on("response", (res) => {
				if (res.statusCode !== 200 || input !== undefined) {
					res.resume();
					finish(new DockerError(res.statusCode ?? 0, "exec attach"));
					return;
				}
				attach(res as unknown as Duplex);
			});
			req.on("error", () => finish(new Error("Docker exec transport lost; outcome unknown")));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			else req.end(JSON.stringify({ Detach: false, Tty: false }));
		});
	}
}
