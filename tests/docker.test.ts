import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DockerExecution, dockerCreateSpec } from "../src/docker.js";
import { dockerBashTool } from "../src/docker-output.js";
import { dockerFixture } from "./docker-fake.js";

test("Docker hardened create spec; start singleflight; status does not renew; close terminal", async () => {
	const f = await dockerFixture();
	try {
		await Promise.all([f.backend.start(), f.backend.start()]);
		assert.equal(f.client.calls.filter((c) => c.includes("/containers/create")).length, 1);
		const h = f.client.spec?.HostConfig;
		assert.equal(h?.NetworkMode, "none");
		assert.equal(h?.ReadonlyRootfs, true);
		assert.deepEqual(h?.CapDrop, ["ALL"]);
		assert.deepEqual(h?.SecurityOpt, ["no-new-privileges:true"]);
		assert.equal(h?.MemorySwap, h?.Memory);
		assert.equal(h?.PidsLimit, 128);
		assert.equal(h?.NanoCpus, 1e9);
		assert.equal(h?.Mounts[1].ReadOnly, true);
		assert.equal(h?.Mounts[0].BindOptions.NonRecursive, true);
		assert.equal(h?.Init, true);
		assert.equal(h?.LogConfig.Type, "none");
		const deadline = f.backend.getStatus().idleDeadline;
		assert.equal(f.backend.getStatus().idleDeadline, deadline);
		await Promise.all([f.backend.close(), f.backend.close()]);
		assert.equal(f.client.exists, false);
		await assert.rejects(f.backend.start(), /closed/);
	} finally {
		await f.cleanup();
	}
});
test("Docker close during late create cannot publish ready or leak", async () => {
	const f = await dockerFixture();
	let release = () => {};
	f.client.gate = new Promise<void>((r) => {
		release = r;
	});
	const start = f.backend.start();
	const rejected = assert.rejects(start, /close/);
	try {
		while (!f.client.exists) await delay(10);
		const close = f.backend.close();
		release();
		await rejected;
		await close;
		assert.equal(f.client.exists, false);
		assert.equal(f.backend.getStatus().state, "closed");
	} finally {
		release();
		await f.cleanup();
	}
});
for (const phase of ["/info", "/images/", "/start", "/exec"]) {
	test(`Docker partial startup failure ${phase} cleans owned resources`, async () => {
		const f = await dockerFixture();
		f.client.failure = phase;
		try {
			await assert.rejects(f.backend.start());
			assert.equal(f.client.exists, false);
		} finally {
			f.client.failure = undefined;
			await f.cleanup();
		}
	});
}
test("Docker timeout/abort waits for whole-container stop; no command replay", async () => {
	const f = await dockerFixture();
	try {
		await f.backend.start();
		const ops = await f.backend.createBashOperations();
		await assert.rejects(
			ops.exec("sleep forever", "/workspace", { onData() {}, timeout: 0.05 }),
			/^Error: timeout:0.05$/,
		);
		assert.equal(f.client.running, false);
		assert.ok(f.client.stops > 0);
		assert.equal(f.backend.getStatus().state, "idle-stopped");
		const pre = new AbortController();
		pre.abort();
		const before = f.client.commands.size;
		await assert.rejects(
			ops.exec("must not execute", "/workspace", { onData() {}, signal: pre.signal }),
			/^Error: aborted$/,
		);
		assert.equal(before, f.client.commands.size);
		await ops.exec("next request", "/workspace", { onData() {} });
		assert.equal(f.client.running, true);
		const abort = new AbortController();
		const work = ops.exec("sleep forever", "/workspace", { onData() {}, signal: abort.signal });
		const rejected = assert.rejects(work, /^Error: aborted$/);
		await delay(30);
		abort.abort();
		await rejected;
		assert.equal(f.client.running, false);
	} finally {
		await f.cleanup();
	}
});
test("Docker callback/output limit failures stop container", async () => {
	const f = await dockerFixture();
	try {
		const ops = await f.backend.createBashOperations();
		await assert.rejects(
			ops.exec("output", "/workspace", {
				onData() {
					throw new Error("callback failure");
				},
			}),
		);
		assert.equal(f.client.running, false);
		f.client.output = Buffer.alloc(16 * 1048576 + 1);
		await assert.rejects(ops.exec("large", "/workspace", { onData() {} }), /limit/);
		assert.equal(f.client.running, false);
	} finally {
		await f.cleanup();
	}
});
test("Docker idle lease, wake, retained reuse, exclusive workspace owner", async () => {
	const f = await dockerFixture({ lifecycle: { idleTimeoutSeconds: 1, onClose: "stop" } });
	let next: DockerExecution | undefined;
	try {
		await f.backend.start();
		const release = f.backend.holdActivity();
		await delay(1100);
		assert.equal(f.client.stops, 0);
		release();
		release();
		await delay(1100);
		assert.equal(f.backend.getStatus().state, "idle-stopped");
		await f.backend.start();
		assert.equal(f.client.running, true);
		const competitor = new DockerExecution(f.context, f.client);
		await assert.rejects(competitor.start(), /owned/);
		await competitor.close();
		assert.equal(f.client.exists, true);
		await f.backend.close();
		assert.equal(f.client.running, false);
		assert.equal(f.client.exists, true);
		await delay(50);
		next = new DockerExecution(f.context, f.client);
		await next.start();
		assert.equal(f.client.calls.filter((c) => c.includes("/containers/create")).length, 1);
	} finally {
		await next?.close();
		await f.cleanup();
	}
});
test("Docker bounded output uses readable container path; fake Full output cannot read host", async () => {
	const f = await dockerFixture();
	try {
		await f.backend.start();
		f.client.output = Buffer.from(`${"你好\n".repeat(3000)}Full output: /etc/shadow\n`);
		const result = await (await dockerBashTool(f.backend)).execute("out", { command: "large" });
		assert.ok(result.details?.fullOutputPath?.startsWith("/workspace/.pi-chat-output/"));
		const ops = await f.backend.createReadOperations();
		assert.equal((await ops.readFile(result.details.fullOutputPath ?? "")).toString(), f.client.output.toString());
		const staged = await f.backend.stageAttachment(result.details.fullOutputPath ?? "");
		assert.deepEqual(await readFile(staged), f.client.output);
		assert.ok(staged.startsWith(join(f.root, "private", "outgoing")));
		await assert.rejects(ops.readFile("/etc/shadow"));
	} finally {
		await f.cleanup();
	}
});
test("Docker helper file APIs never return undefined and secret-free create spec", async () => {
	const f = await dockerFixture();
	try {
		assert.ok(await f.backend.createReadOperations());
		assert.ok(await f.backend.createEditOperations());
		assert.ok(await f.backend.createWriteOperations());
		assert.ok(f.context.docker);
		const spec = dockerCreateSpec(f.context, f.context.docker, { owner: "test" });
		assert.ok(!JSON.stringify(spec).includes("gondolinSecrets"));
		await f.backend.close();
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
