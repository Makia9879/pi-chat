import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerFrames, EngineClient } from "../src/docker-client.js";

export function frame(stream: number, bytes: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header[0] = stream;
	header.writeUInt32BE(bytes.length, 4);
	return Buffer.concat([header, bytes]);
}
test("Docker frames preserve arbitrary binary/Unicode splits and stdout/stderr", () => {
	const data = Buffer.concat([frame(1, Buffer.from("你好\n")), frame(2, Buffer.from([0, 255, 128]))]);
	for (let width = 1; width <= data.length; width++) {
		const output: Buffer[] = [];
		const parser = new DockerFrames((b) => output.push(Buffer.from(b)));
		for (let i = 0; i < data.length; i += width) parser.push(data.subarray(i, i + width));
		parser.end();
		assert.deepEqual(Buffer.concat(output), Buffer.concat([Buffer.from("你好\n"), Buffer.from([0, 255, 128])]));
	}
	assert.throws(() => new DockerFrames(() => undefined).push(frame(9, Buffer.from("x"))));
	assert.throws(() => new DockerFrames(() => undefined, 1).push(frame(1, Buffer.from("xx"))));
	const partial = new DockerFrames(() => undefined);
	partial.push(Buffer.from([1]));
	assert.throws(() => partial.end());
	assert.throws(() =>
		new DockerFrames(() => {
			throw new Error("callback");
		}).push(frame(1, Buffer.from("x"))),
	);
});
test("Engine negotiation, structured JSON, sanitized errors, attached stream", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-engine-"));
	const socketPath = join(root, "engine.sock");
	const paths: string[] = [];
	const server = createServer((req, res) => {
		paths.push(req.url ?? "");
		if (req.url === "/version") res.end(JSON.stringify({ ApiVersion: "1.45", MinAPIVersion: "1.24" }));
		else if (req.url === "/v1.45/info") res.end('{"OSType":"linux"}');
		else res.writeHead(500).end('{"message":"PRIVATE_SENTINEL"}');
	});
	server.on("upgrade", (_req, socket) => {
		socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
		socket.end(frame(1, Buffer.from("attached")));
	});
	await new Promise<void>((r) => server.listen(socketPath, r));
	try {
		const client = new EngineClient(socketPath);
		await client.negotiate();
		assert.deepEqual(await client.json("GET", "/info"), { OSType: "linux" });
		await assert.rejects(client.json("GET", "/missing"), (error: Error) => !error.message.includes("PRIVATE_SENTINEL"));
		let text = "";
		await client.exec(
			"test",
			undefined,
			(b) => {
				text += b.toString();
			},
			new AbortController().signal,
		);
		assert.equal(text, "attached");
		assert.ok(paths.includes("/v1.45/info"));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		await rm(root, { recursive: true, force: true });
	}
});
