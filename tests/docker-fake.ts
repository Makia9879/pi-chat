import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DockerContext, DockerExecution } from "../src/docker.js";
import type { DockerClient } from "../src/docker-client.js";
import { DockerError } from "../src/docker-client.js";
import { type DockerConfig, resolveDockerSettings } from "../src/docker-config.js";
import { safeFile } from "../src/safe-files.js";

export const TEST_IMAGE = `example.invalid/pi-chat@sha256:${"a".repeat(64)}`;
type Spec = ReturnType<typeof import("../src/docker.js").dockerCreateSpec>;
export class FakeDocker implements DockerClient {
	calls: string[] = [];
	spec?: Spec;
	running = false;
	exists = false;
	commands = new Map<string, { Cmd: string[] }>();
	failure?: string;
	gate?: Promise<void>;
	output = Buffer.from("ok");
	exitCode = 0;
	stops = 0;
	async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		this.calls.push(`${method} ${path}`);
		if (this.failure && path.includes(this.failure)) throw new Error("injected daemon failure");
		let value: unknown;
		if (path === "/info")
			value = {
				OSType: "linux",
				SecurityOptions: ["name=seccomp,profile=builtin"],
				Runtimes: { runc: {} },
				MemoryLimit: true,
				SwapLimit: true,
				CpuCfsQuota: true,
				PidsLimit: true,
			};
		else if (path.startsWith("/images/"))
			value = {
				Id: "sha256:image",
				Os: "linux",
				Architecture: process.arch === "x64" ? "amd64" : process.arch,
				RepoDigests: [TEST_IMAGE],
				Config: {
					Labels: { "org.pi-chat.helper": "1" },
					Entrypoint: ["/usr/bin/python3", "-I", "/opt/pi-chat/entry.py"],
					Cmd: [],
					Env: ["PATH=/usr/bin:/bin"],
				},
			};
		else if (path.startsWith("/containers/json")) value = this.exists ? [{ Id: "container" }] : [];
		else if (path.startsWith("/containers/create")) {
			this.spec = body as Spec;
			this.exists = true;
			await this.gate;
			value = { Id: "container" };
		} else if (path.endsWith("/start")) {
			this.running = true;
		} else if (path.includes("/stop") || path.endsWith("/kill")) {
			this.stops++;
			this.running = false;
		} else if (method === "DELETE") {
			this.exists = false;
			this.running = false;
		} else if (path === "/containers/container/json") {
			if (!this.exists) throw new DockerError(404, "inspect");
			value = {
				Id: "container",
				Image: "sha256:image",
				State: { Running: this.running },
				Config: this.spec,
				// Engine serializes maps in its own order, not the create request's order.
				HostConfig: {
					...this.spec?.HostConfig,
					Tmpfs: Object.fromEntries(Object.entries(this.spec?.HostConfig.Tmpfs ?? {}).reverse()),
				},
				Mounts: this.spec?.HostConfig.Mounts.map((m) => ({
					Source: m.Source,
					Destination: m.Target,
					RW: !m.ReadOnly,
					Propagation: "rprivate",
				})),
			};
		} else if (path.endsWith("/exec")) {
			const id = `exec${this.commands.size}`;
			this.commands.set(id, body as { Cmd: string[] });
			value = { Id: id };
		} else if (path.startsWith("/exec/")) value = { Running: false, ExitCode: this.exitCode };
		else throw new Error(`Unexpected fake operation ${method} ${path}`);
		return value as T;
	}
	async exec(
		id: string,
		input: Buffer | undefined,
		onData: (data: Buffer, stream: number) => void,
		signal: AbortSignal,
	): Promise<void> {
		const cmd = this.commands.get(id)?.Cmd ?? [];
		if (signal.aborted) throw new Error("aborted");
		if (cmd.includes("sleep forever")) {
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
			);
			return;
		}
		const helper = cmd.indexOf("/opt/pi-chat/files.py");
		if (helper >= 0) {
			const [op, mount, rel] = cmd.slice(helper + 1);
			const root = this.spec?.HostConfig.Mounts.find((m) => m.Target === mount)?.Source;
			if (!root) throw new Error("missing fake mount");
			onData(await safeFile(op, root, join(root, rel), input), 1);
		} else if (cmd.includes("/bin/bash")) onData(this.output, 1);
	}
}
export async function dockerFixture(overrides: DockerConfig = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-docker-unit-"));
	const context: DockerContext = {
		workspaceDir: join(root, "workspace"),
		sharedDir: join(root, "shared"),
		dockerDir: join(root, "private"),
		docker: resolveDockerSettings([{ image: TEST_IMAGE, ...overrides }]),
		gondolinSecrets: {},
	};
	const client = new FakeDocker();
	const backend = new DockerExecution(context, client);
	return {
		root,
		context,
		client,
		backend,
		cleanup: async () => {
			await backend.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
