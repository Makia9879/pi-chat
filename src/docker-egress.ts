import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import {
	type ClientRequest,
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Transform } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { type DockerPolicy, guardedAddress } from "./docker-policy.js";

const openssl = promisify(execFile);
export type ProxyConnector = (
	secure: boolean,
	options: RequestOptions,
	response: (message: IncomingMessage) => void,
) => ClientRequest;
const defaultConnector: ProxyConnector = (secure, options, response) =>
	(secure ? httpsRequest : httpRequest)(options, response);

const HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
function bounded(limit: number): Transform {
	let count = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			count += chunk.length;
			callback(count > limit ? new Error("egress: byte limit") : null, chunk);
		},
	});
}
function authority(value: string, secure: boolean): string {
	if (!value || /[\s/@\\#?%]/.test(value)) throw new Error("egress: invalid authority");
	const split = value.split(":");
	if (split.length > 2 || (split.length === 2 && split[1] !== (secure ? "443" : "80")))
		throw new Error("egress: invalid port");
	return split[0];
}
/** Node's maintained HTTP/1 parser and TLS stack, not a custom byte parser.
 * No blind tunnel; every CONNECT is terminated and every upstream connection pinned.
 */
export class DockerEgress {
	private readonly sockets = new Set<Socket>();
	private readonly tunnels = new WeakMap<Socket, string>();
	private readonly outer = createServer({ maxHeaderSize: 32768 }, (req, res) => void this.forward(req, res));
	private readonly inner = createServer({ maxHeaderSize: 32768 }, (req, res) => void this.forward(req, res));
	private closed = false;
	private active = 0;
	constructor(
		readonly policy: DockerPolicy,
		readonly directory: string,
		private readonly hold: () => () => void,
		private readonly resolveAddress = guardedAddress,
		private readonly connector: ProxyConnector = defaultConnector,
	) {}
	get publicDir(): string {
		return join(this.directory, "proxy-public");
	}
	get env(): Record<string, string> {
		return {
			...this.policy.env,
			HTTP_PROXY: "http://127.0.0.1:18080",
			HTTPS_PROXY: "http://127.0.0.1:18080",
			http_proxy: "http://127.0.0.1:18080",
			https_proxy: "http://127.0.0.1:18080",
			NO_PROXY: "",
			no_proxy: "",
			SSL_CERT_FILE: "/run/pi-chat-proxy/ca.pem",
			CURL_CA_BUNDLE: "/run/pi-chat-proxy/ca.pem",
			REQUESTS_CA_BUNDLE: "/run/pi-chat-proxy/ca.pem",
			NODE_EXTRA_CA_CERTS: "/run/pi-chat-proxy/ca.pem",
		};
	}
	async start(): Promise<void> {
		const privateDir = join(this.directory, "proxy-private");
		await mkdir(privateDir, { recursive: true, mode: 0o700 });
		await mkdir(this.publicDir, { recursive: true, mode: 0o700 });
		const key = join(privateDir, "ca.key");
		const cert = join(this.publicDir, "ca.pem");
		const args = [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=pi-chat session proxy",
			"-addext",
			"basicConstraints=critical,CA:TRUE",
		];
		await openssl("/usr/bin/openssl", args, { timeout: 10000, maxBuffer: 65536, env: { PATH: "/usr/bin:/bin" } });
		await chmod(key, 0o600);
		const leafKey = join(privateDir, "leaf.key");
		const csr = join(privateDir, "leaf.csr");
		const leaf = join(privateDir, "leaf.pem");
		const hosts = this.policy.network.allowedHosts;
		if (hosts.length > 64) throw new Error("egress: at most 64 allowed hosts");
		await openssl(
			"/usr/bin/openssl",
			[
				"req",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				leafKey,
				"-out",
				csr,
				"-subj",
				"/CN=pi-chat intercepted upstream",
				"-addext",
				`subjectAltName=${(hosts.length ? hosts : ["denied.invalid"]).map((h) => `DNS:${h}`).join(",")}`,
			],
			{ timeout: 10000, maxBuffer: 65536 },
		);
		await chmod(leafKey, 0o600);
		await openssl(
			"/usr/bin/openssl",
			[
				"x509",
				"-req",
				"-in",
				csr,
				"-CA",
				cert,
				"-CAkey",
				key,
				"-set_serial",
				"1",
				"-out",
				leaf,
				"-days",
				"1",
				"-copy_extensions",
				"copy",
			],
			{ timeout: 10000, maxBuffer: 65536 },
		);
		const context = createSecureContext({
			key: await readFile(leafKey),
			cert: await readFile(leaf),
			minVersion: "TLSv1.2",
		});
		for (const server of [this.outer, this.inner]) {
			server.headersTimeout = 10000;
			server.requestTimeout = 120000;
			server.keepAliveTimeout = 1000;
			server.on("clientError", (_err, socket) => socket.destroy());
			server.on("upgrade", (_req, socket) => socket.destroy());
		}
		this.inner.on("connect", (_req, socket) => socket.destroy());
		this.outer.on("connection", (socket) => {
			if (this.closed || this.sockets.size >= 32) {
				socket.destroy();
				return;
			}
			this.sockets.add(socket);
			socket.setTimeout(30000, () => socket.destroy());
			const timer = setTimeout(() => socket.destroy(), 120000);
			socket.on("close", () => {
				clearTimeout(timer);
				this.sockets.delete(socket);
			});
		});
		this.outer.on("connect", (req, raw, head) => {
			try {
				if (this.closed || head.length || !req.url?.endsWith(":443")) throw new Error("denied");
				const host = this.policy.host(authority(req.url, true));
				if (this.policy.host(authority(req.headers.host ?? "", true)) !== host) throw new Error("denied");
				raw.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				const tls = new TLSSocket(raw, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
				this.tunnels.set(tls, host);
				tls.on("error", () => tls.destroy());
				tls.on("secure", () => {
					if ((tls as TLSSocket & { servername?: string }).servername !== host) tls.destroy();
				});
				this.inner.emit("connection", tls);
			} catch {
				raw.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			}
		});
		const socketPath = join(this.publicDir, "proxy.sock");
		await rm(socketPath, { force: true });
		await new Promise<void>((resolve, reject) => {
			this.outer.once("error", reject);
			this.outer.listen(socketPath, () => {
				this.outer.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(socketPath, 0o600);
	}
	private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (this.closed || this.active >= 32) {
			res.writeHead(503).end();
			return;
		}
		this.active++;
		const release = this.hold();
		let finished = false;
		const end = () => {
			if (!finished) {
				finished = true;
				this.active--;
				release();
			}
		};
		res.once("close", end);
		try {
			const tunnel = this.tunnels.get(req.socket);
			if (!req.url || req.method === "CONNECT" || req.headers.upgrade) throw new Error("egress: protocol denied");
			const url = tunnel ? new URL(req.url, `https://${tunnel}`) : new URL(req.url);
			if (
				tunnel &&
				(!req.url.startsWith("/") ||
					req.url.startsWith("//") ||
					url.protocol !== "https:" ||
					url.hostname !== tunnel ||
					(req.socket as TLSSocket & { servername?: string }).servername !== tunnel)
			)
				throw new Error("egress: authority mismatch");
			if (!tunnel && url.protocol !== "http:") throw new Error("egress: CONNECT required");
			const host = this.policy.host(url.hostname);
			if (this.policy.host(authority(req.headers.host ?? "", Boolean(tunnel))) !== host)
				throw new Error("egress: host mismatch");
			const headers: Record<string, string> = {};
			const seen = new Set<string>();
			const connection = String(req.headers.connection ?? "")
				.toLowerCase()
				.split(",")
				.map((v) => v.trim());
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const key = req.rawHeaders[i].toLowerCase();
				if (seen.has(key)) throw new Error("egress: duplicate header");
				seen.add(key);
				if (!HOP.has(key) && !connection.includes(key)) headers[key] = req.rawHeaders[i + 1];
			}
			const rewritten = this.policy.rewrite(url, headers);
			const address = await this.resolveAddress(host);
			if (this.closed || res.destroyed) throw new Error("egress: revoked");
			const upstream = this.connector(
				Boolean(tunnel),
				{
					hostname: address.address,
					family: address.family,
					servername: host,
					port: tunnel ? 443 : 80,
					method: req.method,
					path: url.pathname + url.search,
					headers: { ...rewritten, host, connection: "close" },
					agent: false,
					rejectUnauthorized: true,
					maxHeaderSize: 32768,
				},
				(response) => {
					const responseHeaders = { ...response.headers };
					for (const name of HOP) delete responseHeaders[name];
					res.writeHead(response.statusCode ?? 502, responseHeaders);
					const cap = bounded(64 * 1024 * 1024);
					cap.on("error", () => {
						response.destroy();
						res.destroy();
					});
					response.on("error", () => res.destroy());
					response.pipe(cap).pipe(res);
				},
			);
			const timer = setTimeout(() => upstream.destroy(new Error("egress: deadline")), 120000);
			upstream.setTimeout(30000, () => upstream.destroy());
			upstream.on("error", () => {
				if (!res.headersSent) res.writeHead(502).end("egress: upstream rejected");
				else res.destroy();
			});
			res.once("close", () => {
				clearTimeout(timer);
				upstream.destroy();
			});
			req.once("aborted", () => upstream.destroy());
			const cap = bounded(16 * 1024 * 1024);
			cap.on("error", () => {
				upstream.destroy();
				req.destroy();
			});
			req.pipe(cap).pipe(upstream);
		} catch {
			res.writeHead(403, { Connection: "close" }).end("egress: request denied");
		}
	}
	revoke(): void {
		for (const socket of this.sockets) socket.destroy();
	}
	async close(): Promise<void> {
		this.closed = true;
		this.revoke();
		if (this.outer.listening) await new Promise<void>((resolve) => this.outer.close(() => resolve()));
		await rm(join(this.directory, "proxy-private"), { recursive: true, force: true });
		await rm(this.publicDir, { recursive: true, force: true });
	}
}
