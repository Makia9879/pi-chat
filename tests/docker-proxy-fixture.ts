import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
	request as httpRequest,
	createServer as httpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest, createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DockerEgress, type ProxyConnector } from "../src/docker-egress.js";
import type { DockerPolicy } from "../src/docker-policy.js";

/** Explicit test-only loopback upstream seam; never a runtime configuration option. */
export async function proxyFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-upstream-"));
	const cert = join(root, "cert.pem"),
		key = join(root, "key.pem");
	await promisify(execFile)(
		"/usr/bin/openssl",
		[
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
			"/CN=api.example.com",
			"-addext",
			"subjectAltName=DNS:api.example.com",
		],
		{ timeout: 10000 },
	);
	const requests: Array<{ url?: string; authorization?: string; body: string }> = [];
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (b: Buffer) => {
			body += b.toString();
		});
		req.on("end", () => {
			requests.push({ url: req.url, authorization: req.headers.authorization, body });
			if (req.url === "/redirect") {
				res.writeHead(302, { location: "https://denied.invalid/" }).end();
				return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ authorization: req.headers.authorization, body, url: req.url }));
		});
	};
	const ca = await readFile(cert);
	const plain = httpServer(handler),
		secure = httpsServer({ key: await readFile(key), cert: ca }, handler);
	await Promise.all([
		new Promise<void>((r) => plain.listen(0, "127.0.0.1", r)),
		new Promise<void>((r) => secure.listen(0, "127.0.0.1", r)),
	]);
	const port = (s: typeof plain) => {
		const address = s.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		return address.port;
	};
	const connector: ProxyConnector = (tls, options, response) =>
		(tls ? httpsRequest : httpRequest)(
			{ ...options, hostname: "127.0.0.1", port: port(tls ? secure : plain), ca, rejectUnauthorized: true },
			response,
		);
	const factory = (policy: DockerPolicy, directory: string, hold: () => () => void) =>
		new DockerEgress(policy, directory, hold, async () => ({ address: "127.0.0.1", family: 4 }), connector);
	return {
		root,
		requests,
		factory,
		close: async () => {
			plain.closeAllConnections();
			secure.closeAllConnections();
			await Promise.all([
				new Promise<void>((r) => plain.close(() => r())),
				new Promise<void>((r) => secure.close(() => r())),
			]);
			await rm(root, { recursive: true, force: true });
		},
	};
}
