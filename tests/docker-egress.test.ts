import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect as tlsConnect } from "node:tls";
import { DockerPolicy } from "../src/docker-policy.js";
import { proxyFixture } from "./docker-proxy-fixture.js";

function plain(
	socketPath: string,
	target: string,
	headers: Record<string, string> = {},
): Promise<{ code: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, path: target, headers: { host: new URL(target).host, ...headers } }, (res) => {
			let text = "";
			res.on("data", (b) => {
				text += b.toString();
			});
			res.on("end", () => resolve({ code: res.statusCode ?? 0, text }));
		});
		req.on("error", reject);
		req.end();
	});
}
async function tunnel(
	socketPath: string,
	ca: Buffer,
	token: string,
	innerHost = "api.example.com",
	servername = "api.example.com",
): Promise<string> {
	const raw = connect(socketPath);
	await new Promise<void>((resolve, reject) => {
		raw.once("connect", resolve);
		raw.once("error", reject);
	});
	raw.write("CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n");
	await new Promise<void>((resolve, reject) => {
		raw.once("data", (b) => (b.toString().includes("200") ? resolve() : reject(new Error("CONNECT denied"))));
	});
	const tls = tlsConnect({ socket: raw, servername, ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
	return new Promise((resolve, reject) => {
		let text = "";
		tls.setTimeout(3000, () => tls.destroy(new Error("timeout")));
		tls.on("secureConnect", () =>
			tls.write(
				`GET /headers HTTP/1.1\r\nHost: ${innerHost}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
			),
		);
		tls.on("data", (b) => {
			text += b.toString();
		});
		tls.on("end", () => resolve(text));
		tls.on("error", reject);
	});
}
test("Unix proxy HTTP/TLS policy, host consistency, secret injection and revocation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-proxy-test-"));
	const fixture = await proxyFixture();
	let leases = 0;
	const policy = new DockerPolicy(
		{ mode: "proxy", allowedHosts: ["api.example.com"], replaceSecretsInQuery: false },
		{ TOKEN: { value: "REAL_TEST_ONLY", hosts: ["api.example.com"] } },
	);
	const proxy = fixture.factory(policy, root, () => {
		leases++;
		return () => {
			leases--;
		};
	});
	try {
		await proxy.start();
		const socket = join(proxy.publicDir, "proxy.sock");
		assert.equal((await plain(socket, "http://api.example.com/hello")).code, 200);
		assert.equal((await plain(socket, "http://denied.invalid/")).code, 403);
		assert.equal((await plain(socket, "http://api.example.com/", { authorization: policy.env.TOKEN })).code, 403);
		assert.equal(fixture.requests.length, 1);
		const ca = await readFile(join(proxy.publicDir, "ca.pem"));
		const result = await tunnel(socket, ca, policy.env.TOKEN);
		assert.match(result, /REAL_TEST_ONLY/); // Deliberate echo documents the residual disclosure risk.
		assert.equal(fixture.requests.at(-1)?.authorization, "Bearer REAL_TEST_ONLY");
		const count = fixture.requests.length;
		assert.match(await tunnel(socket, ca, policy.env.TOKEN, "denied.invalid"), /403/);
		assert.match(await tunnel(socket, ca, "PI_CHAT_SECRET_expired"), /403/);
		assert.equal(fixture.requests.length, count);
		await proxy.close();
		await assert.rejects(plain(socket, "http://api.example.com/"));
		assert.equal(leases, 0);
	} finally {
		await proxy.close();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	}
});
