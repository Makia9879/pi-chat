import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { type DockerContext, DockerExecution } from "../../src/docker.js";
import { DockerError, EngineClient } from "../../src/docker-client.js";
import { type DockerConfig, resolveDockerSettings } from "../../src/docker-config.js";
import { dockerBashTool } from "../../src/docker-output.js";
import { safeFile } from "../../src/safe-files.js";
import { writeRuntimeSecret } from "../../src/secrets.js";
import { proxyFixture } from "../docker-proxy-fixture.js";

if (
	process.env.PI_CHAT_DOCKER_E2E !== "1" ||
	!process.env.PI_CHAT_DOCKER_IMAGE ||
	!process.env.PI_CHAT_DOCKER_WORKSPACE?.startsWith("/")
)
	throw new Error(
		"E2E requires PI_CHAT_DOCKER_E2E=1, explicit pinned PI_CHAT_DOCKER_IMAGE and disposable absolute PI_CHAT_DOCKER_WORKSPACE",
	);
const runtime = process.env.PI_CHAT_DOCKER_RUNTIME ?? "runc";
const image = process.env.PI_CHAT_DOCKER_IMAGE;
const workspace = process.env.PI_CHAT_DOCKER_WORKSPACE;
assert.ok(workspace);

async function setup(overrides: DockerConfig = {}, proxy = false) {
	await mkdir(workspace, { recursive: true });
	const root = await mkdtemp(join(workspace, "pi-chat-e2e-"));
	const fixture = proxy ? await proxyFixture() : undefined;
	const secrets: DockerContext["gondolinSecrets"] = proxy
		? { TOKEN: { value: "PI_CHAT_E2E_ONLY_REAL_TOKEN", hosts: ["api.example.com"] } }
		: {};
	const context: DockerContext = {
		workspaceDir: join(root, "workspace"),
		sharedDir: join(root, "shared"),
		dockerDir: join(root, "private"),
		gondolinSecrets: secrets,
		docker: resolveDockerSettings(
			[{ image, runtime, memoryMiB: 256, tmpfsMiB: 32, pidsLimit: 64, cpus: 0.5, ...overrides }],
			secrets,
		),
	};
	const client = new EngineClient();
	const backend = new DockerExecution(context, client, fixture?.factory);
	try {
		await backend.start();
	} catch (error) {
		await backend.close();
		await fixture?.close();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
	const ops = await backend.createBashOperations();
	const bash = async (command: string, timeout = 10) => {
		let text = "";
		const result = await ops.exec(command, "/workspace", {
			timeout,
			onData: (b) => {
				text += b.toString();
			},
		});
		return { ...result, text };
	};
	return {
		root,
		context,
		client,
		backend,
		bash,
		fixture,
		close: async () => {
			const before = JSON.parse(await readFile(join(root, "private", "session.json"), "utf8")) as { id?: string };
			try {
				await backend.close();
			} finally {
				await fixture?.close();
			}
			const meta = JSON.parse(await readFile(join(root, "private", "session.json"), "utf8")) as { id?: string };
			if (context.docker?.lifecycle.onClose === "remove") {
				assert.equal(meta.id, undefined, "remove must not leave retained metadata");
				if (before.id)
					await assert.rejects(
						client.json("GET", `/containers/${before.id}/json`),
						(error: unknown) => error instanceof DockerError && error.status === 404,
					);
			}
			if (meta.id) {
				const info = await client.json<{ Config: { Labels: Record<string, string> } }>(
					"GET",
					`/containers/${meta.id}/json`,
				);
				assert.equal(info.Config.Labels["org.pi-chat.managed"], "1");
				await client.json("DELETE", `/containers/${meta.id}?force=1`);
			}
			await rm(root, { recursive: true, force: true });
		},
	};
}

test(`REAL ${runtime}: hardening, env, mounts, tools, bridge, output`, { timeout: 120000 }, async () => {
	process.env.PI_CHAT_HOST_SENTINEL = "MUST_NOT_REACH_CONTAINER";
	const f = await setup();
	try {
		const basic = await f.bash(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by container bash, not JavaScript.
			"pwd; id; printf 'HOST=%s\\n' \"${PI_CHAT_HOST_SENTINEL-unset}\"; grep -E 'CapEff|NoNewPrivs|Seccomp' /proc/self/status; cat /proc/mounts",
		);
		assert.equal(basic.exitCode, 0);
		assert.match(basic.text, /\/workspace/);
		assert.match(basic.text, /HOST=unset/);
		assert.match(basic.text, /CapEff:\s+0+/);
		assert.match(basic.text, /NoNewPrivs:\s+1/);
		const meta = JSON.parse(await readFile(join(f.root, "private", "session.json"), "utf8")) as { id: string };
		const info = await f.client.json<{ HostConfig: Record<string, unknown>; Config: { Env: string[] } }>(
			"GET",
			`/containers/${meta.id}/json`,
		);
		assert.equal(info.HostConfig.NetworkMode, "none");
		assert.equal(info.HostConfig.ReadonlyRootfs, true);
		assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
		assert.equal(info.HostConfig.Runtime, runtime);
		assert.equal(info.HostConfig.Memory, 256 * 1048576);
		assert.equal(info.HostConfig.MemorySwap, info.HostConfig.Memory);
		assert.equal(info.HostConfig.PidsLimit, 64);
		assert.equal(info.HostConfig.NanoCpus, 5e8);
		assert.equal((await f.bash("touch /rootfs-write-denied /shared/write-denied 2>/dev/null")).exitCode === 0, false);
		if (runtime === "runc") {
			assert.match(basic.text, /Seccomp:\s+2/);
			const cgroups = await f.bash(
				"cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max",
			);
			assert.equal(cgroups.exitCode, 0);
			assert.match(cgroups.text, /268435456/);
			assert.match(cgroups.text, /64/);
			assert.match(cgroups.text, /50000 100000/);
			console.log("E2E_EFFECTIVE_CGROUPS", cgroups.text.trim());
		}
		const write = createWriteTool("/workspace", { operations: await f.backend.createWriteOperations() });
		await f.backend.withToolTransaction(() => write.execute("w", { path: "nested/hello.txt", content: "hello\n你好" }));
		const edit = createEditTool("/workspace", { operations: await f.backend.createEditOperations() });
		await f.backend.withToolTransaction(() =>
			edit.execute("e", { path: "nested/hello.txt", edits: [{ oldText: "hello", newText: "changed" }] }),
		);
		const read = await f.backend.createReadOperations();
		assert.equal((await read.readFile("/workspace/nested/hello.txt")).toString(), "changed\n你好");
		assert.equal((await readFile(await f.backend.stageAttachment("nested/hello.txt"))).toString(), "changed\n你好");
		await safeFile("mkdir", f.context.workspaceDir, join(f.context.workspaceDir, "incoming"));
		await safeFile(
			"write",
			f.context.workspaceDir,
			join(f.context.workspaceDir, "incoming", "download.txt"),
			Buffer.from("download"),
		);
		await writeRuntimeSecret(f.context.workspaceDir, "test-token", "plaintext-by-design");
		assert.equal(
			(await f.bash("cat incoming/download.txt .secrets/test-token; stat -c '%a' .secrets/test-token")).text,
			"downloadplaintext-by-design600\n",
		);
		const sentinel = join(f.root, "HOST_ONLY");
		await writeFile(sentinel, "HOST_PRIVATE");
		assert.notEqual((await f.bash(`cat '${sentinel}' 2>/dev/null`)).exitCode, 0);
		// No DNS server or routable interface: explicit proxy removal cannot open egress.
		const offline = await f.bash(`python3 - <<'PY'
import socket
for family,address in [(socket.AF_INET,('1.1.1.1',443)),(socket.AF_INET,('169.254.169.254',80)),(socket.AF_INET,('10.0.0.1',80)),(socket.AF_INET6,('2606:4700:4700::1111',443))]:
 for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
  s=socket.socket(family,kind);s.settimeout(0.2)
  try:
   if kind==socket.SOCK_STREAM:s.connect(address)
   else:s.sendto(b'test',address)
  except OSError:pass
  else:raise AssertionError('direct network accessible')
  finally:s.close()
print('OFFLINE_OK')
PY`);
		assert.equal(offline.exitCode, 0);
		assert.match(offline.text, /OFFLINE_OK/);
		await f.bash(`ln -s '${sentinel}' /workspace/escape; ln -s /shared /workspace/shared-alias`);
		await assert.rejects(read.readFile("/workspace/escape"));
		await assert.rejects(f.backend.stageAttachment("/workspace/escape"));
		assert.notEqual((await f.bash("touch /workspace/shared-alias/denied 2>/dev/null")).exitCode, 0);
		const output = await (await dockerBashTool(f.backend)).execute("large", {
			command: "python3 -c \"print('你好' * 30000); print('line\\n' * 2100)\"",
		});
		assert.ok(output.details?.fullOutputPath);
		assert.ok((await read.readFile(output.details.fullOutputPath)).length > 50000);
		assert.equal((await f.bash("exit 7")).exitCode, 7);
		const binary: Buffer[] = [];
		await (await f.backend.createBashOperations()).exec(
			"python3 -c 'import sys;sys.stdout.buffer.write(bytes(range(256))*1024)'",
			"/workspace",
			{ onData: (chunk) => binary.push(Buffer.from(chunk)) },
		);
		const block = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
		assert.deepEqual(Buffer.concat(binary), Buffer.concat(Array.from({ length: 1024 }, () => block)));
		for (const name of ["memory.md", "SYSTEM.md", "skills/example/SKILL.md"]) {
			await safeFile("mkdir", f.context.workspaceDir, join(f.context.workspaceDir, name, ".."));
			await safeFile("write", f.context.workspaceDir, join(f.context.workspaceDir, name), Buffer.from(name));
			assert.equal((await read.readFile(`/workspace/${name}`)).toString(), name);
		}
		await f.bash("mkfifo fifo; ln nested/hello.txt hardlink");
		await assert.rejects(read.readFile("/workspace/fifo"));
		await assert.rejects(read.readFile("/workspace/hardlink"));
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
		await f.bash(`python3 -c "import base64;open('image.png','wb').write(base64.b64decode('${png}'))"`);
		const result = await createReadTool("/workspace", { operations: read, autoResizeImages: false }).execute("png", {
			path: "image.png",
		});
		assert.ok(result.content.some((c) => c.type === "image"));
		console.log("E2E_HARDENING", JSON.stringify(f.backend.getStatus()));
	} finally {
		delete process.env.PI_CHAT_HOST_SENTINEL;
		await f.close();
	}
});

test(`REAL ${runtime}: whole-container cancellation, idle, retained reuse`, { timeout: 120000 }, async () => {
	const f = await setup({ lifecycle: { idleTimeoutSeconds: 1, onClose: "stop" } });
	let next: DockerExecution | undefined;
	try {
		const operations = await f.backend.createBashOperations();
		await assert.rejects(
			operations.exec(
				"setsid bash -c 'trap \"\" TERM; while :; do echo tick >> /workspace/ticks; sleep 0.05; done' & wait",
				"/workspace",
				{ timeout: 0.5, onData() {} },
			),
			/timeout:0.5/,
		);
		const ticks = await readFile(join(f.context.workspaceDir, "ticks"));
		await delay(500);
		assert.deepEqual(await readFile(join(f.context.workspaceDir, "ticks")), ticks);
		const controller = new AbortController();
		const pending = operations.exec(
			"echo started > abort-started; while :; do echo tick >> abort-ticks; sleep 0.05; done",
			"/workspace",
			{ signal: controller.signal, onData() {} },
		);
		// Abort only after the writer is observed; waking a runtime may take >500ms.
		for (let attempt = 0; ; attempt++) {
			try {
				assert.ok((await readFile(join(f.context.workspaceDir, "abort-ticks"))).length > 0);
				break;
			} catch (error) {
				if (attempt === 100) {
					controller.abort();
					await pending.catch(() => undefined);
					throw error;
				}
				await delay(100);
			}
		}
		controller.abort();
		await assert.rejects(pending, /^Error: aborted$/);
		const abortedTicks = await readFile(join(f.context.workspaceDir, "abort-ticks"));
		await delay(300);
		assert.deepEqual(await readFile(join(f.context.workspaceDir, "abort-ticks")), abortedTicks);
		await f.bash("echo persistent > marker; echo temporary > /tmp/marker");
		const release = f.backend.holdActivity();
		await delay(1200);
		assert.equal(f.backend.getStatus().state, "ready");
		release();
		await delay(1400);
		assert.equal(f.backend.getStatus().state, "idle-stopped");
		assert.equal((await f.bash("cat marker; test ! -e /tmp/marker")).exitCode, 0);
		const oldId = f.backend.getStatus().container;
		await f.backend.close();
		next = new DockerExecution(f.context);
		await next.start();
		assert.equal(next.getStatus().container, oldId);
		await next.close();
		// A changed immutable limit must rebuild, never reuse the old container.
		assert.ok(f.context.docker);
		next = new DockerExecution({ ...f.context, docker: { ...f.context.docker, cpus: 0.25 } });
		await next.start();
		assert.notEqual(next.getStatus().container, oldId);
		const nextOps = await next.createBashOperations();
		const writing = nextOps.exec("while :; do echo tick >> close-ticks; sleep 0.05; done", "/workspace", {
			onData() {},
		});
		const rejected = assert.rejects(writing);
		await delay(500);
		await next.close();
		await rejected;
		const closedTicks = await readFile(join(f.context.workspaceDir, "close-ticks"));
		await delay(300);
		assert.deepEqual(await readFile(join(f.context.workspaceDir, "close-ticks")), closedTicks);
		next = undefined;
	} finally {
		await next?.close();
		await f.close();
	}
});

test(`REAL ${runtime}: SIGKILL disposable controller, orphan reconciliation`, { timeout: 60000 }, async () => {
	const f = await setup({ lifecycle: { onClose: "stop", idleTimeoutSeconds: 0 } });
	let replacement: DockerExecution | undefined;
	const contextPath = join(f.root, "controller.json");
	await writeFile(contextPath, JSON.stringify(f.context), { mode: 0o600 });
	await f.backend.close();
	const child = spawn(
		process.execPath,
		["--import", "tsx", new URL("./docker-worker.ts", import.meta.url).pathname, contextPath],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("test controller readiness timeout")), 15000);
			child.once("exit", () => {
				clearTimeout(timer);
				reject(new Error("test controller exited before ready"));
			});
			child.once("error", reject);
			child.stdout.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("TEST_WORKER_READY")) {
					clearTimeout(timer);
					resolve();
				}
			});
		});
		const dead = once(child, "exit");
		child.kill("SIGKILL");
		await dead;
		await delay(300); // flock helper releases when the controller pipe closes.
		replacement = new DockerExecution(f.context);
		await replacement.start();
		const ticks = await readFile(join(f.context.workspaceDir, "orphan-ticks"));
		await delay(300);
		assert.deepEqual(await readFile(join(f.context.workspaceDir, "orphan-ticks")), ticks);
		assert.equal(
			(await (await replacement.createBashOperations()).exec("test -f orphan-ticks", "/workspace", { onData() {} }))
				.exitCode,
			0,
		);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const dead = once(child, "exit");
			child.kill("SIGKILL");
			await dead;
		}
		await replacement?.close();
		await f.close();
	}
});

if (runtime === "runc") {
	test("REAL runc: bounded PID, CPU and memory pressure enforce cgroup limits", { timeout: 60000 }, async () => {
		const f = await setup({ memoryMiB: 128, tmpfsMiB: 16, pidsLimit: 32, cpus: 0.25 });
		try {
			const pids = await f.bash(`python3 - <<'PY'
import subprocess
children=[]
try:
 for i in range(40):
  try:children.append(subprocess.Popen(['sleep','10']))
  except BlockingIOError:break
 else:raise AssertionError('PID limit not enforced')
 print('PID_LIMIT',len(children))
finally:
 for p in children:p.terminate()
 for p in children:p.wait()
PY`);
			assert.equal(pids.exitCode, 0);
			assert.match(pids.text, /PID_LIMIT/);
			const cpu = await f.bash(
				"python3 -c 'import time;t=time.monotonic();c=time.process_time();exec(\"while time.monotonic()-t<2: pass\");assert time.process_time()-c<1.5'; cat /sys/fs/cgroup/cpu.stat",
			);
			assert.equal(cpu.exitCode, 0);
			assert.match(cpu.text, /nr_throttled [1-9]/);
			const oom = await f.bash(
				"python3 -c 'x=bytearray(192*1024*1024)' ; result=$?; cat /sys/fs/cgroup/memory.events; exit $result",
			);
			assert.equal(oom.exitCode, 137);
			assert.match(oom.text, /oom_kill [1-9]/);
		} finally {
			await f.close();
		}
	});
	test("REAL runc: mediated HTTP/HTTPS, placeholders, whitelist and direct-network denial", {
		timeout: 120000,
	}, async () => {
		const f = await setup({ network: { mode: "proxy", allowedHosts: ["api.example.com"] } }, true);
		try {
			const env = await f.bash("printf '%s' \"$TOKEN\"");
			assert.match(env.text, /^PI_CHAT_SECRET_/);
			assert.doesNotMatch(env.text, /ONLY_REAL/);
			assert.equal((await f.bash("curl -fsS --max-time 5 http://api.example.com/plain")).exitCode, 0);
			const response = await f.bash(
				'curl -fsS --max-time 5 -H "Authorization: Bearer $TOKEN" https://api.example.com/headers',
			);
			assert.equal(response.exitCode, 0);
			assert.equal(f.fixture?.requests.at(-1)?.authorization, "Bearer PI_CHAT_E2E_ONLY_REAL_TOKEN");
			const count = f.fixture?.requests.length;
			for (const cmd of [
				"curl -f --max-time 3 https://denied.invalid",
				'curl -f --max-time 3 -H "Authorization: Bearer $TOKEN" http://api.example.com',
				"curl -f --max-time 3 -H 'Authorization: Bearer PI_CHAT_SECRET_old' https://api.example.com",
				"curl -f --max-time 3 --noproxy '*' https://1.1.1.1",
				"env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy curl --max-time 3 https://1.1.1.1",
				"curl -f --max-time 3 http://169.254.169.254",
				"curl -f --max-time 3 --unix-socket /run/pi-chat-proxy/proxy.sock -x http://localhost http://denied.invalid",
			])
				assert.notEqual((await f.bash(cmd)).exitCode, 0, cmd);
			assert.equal(f.fixture?.requests.length, count);
			assert.notEqual((await f.bash("curl -fL --max-time 5 https://api.example.com/redirect")).exitCode, 0);
			const metadata = await readFile(join(f.root, "private", "session.json"), "utf8");
			assert.doesNotMatch(metadata, /ONLY_REAL_TOKEN|PI_CHAT_SECRET_/);
		} finally {
			await f.close();
		}
	});
}
