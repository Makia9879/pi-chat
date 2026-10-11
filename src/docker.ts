import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@mariozechner/pi-coding-agent";
import type { GondolinSecretConfig } from "./core/config-types.js";
import { type DockerClient, DockerError, EngineClient } from "./docker-client.js";
import { type DockerSettings, resolveDockerSettings } from "./docker-config.js";
import { DockerEgress } from "./docker-egress.js";
import { DockerPolicy } from "./docker-policy.js";
import type { ConversationExecution } from "./execution.js";
import { FILE_LIMIT } from "./safe-files.js";

export interface DockerContext {
	workspaceDir: string;
	sharedDir: string;
	dockerDir?: string;
	docker?: DockerSettings;
	gondolinSecrets: Record<string, GondolinSecretConfig>;
}
interface Inspection {
	Id: string;
	Image: string;
	State: { Running: boolean; OOMKilled?: boolean };
	Config: { Labels: Record<string, string>; User: string; Image: string };
	HostConfig: Record<string, unknown>;
	Mounts: Array<{ Source: string; Destination: string; RW: boolean; Propagation: string }>;
}
interface ImageInfo {
	Id: string;
	Os: string;
	Architecture: string;
	RepoDigests: string[];
	Config: {
		Labels?: Record<string, string>;
		Entrypoint?: string[];
		Cmd?: string[];
		Volumes?: Record<string, unknown>;
		Env?: string[];
		OnBuild?: string[];
	};
}
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const CLEAN_ENV = ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "HOME=/workspace", "TMPDIR=/tmp"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

export function dockerPath(
	path: string,
	write = false,
	sharedReadOnly = true,
): { root: string; relative: string; path: string } {
	if (!path || path.includes("\0")) throw new Error("Docker file path rejected");
	const normalized = posix.resolve("/workspace", path);
	const root = ["/workspace", "/shared"].find((r) => inside(r, normalized));
	if (!root || (write && root === "/shared" && sharedReadOnly))
		throw new Error("Docker file path outside writable mounts");
	return { root, relative: normalized.slice(root.length + 1), path: normalized };
}
export function dockerCreateSpec(
	context: DockerContext,
	settings: DockerSettings,
	labels: Record<string, string>,
	proxyPublic?: string,
) {
	const mounts = [
		{
			Type: "bind",
			Source: context.workspaceDir,
			Target: "/workspace",
			ReadOnly: false,
			BindOptions: { Propagation: "rprivate", NonRecursive: true },
		},
		{
			Type: "bind",
			Source: context.sharedDir,
			Target: "/shared",
			ReadOnly: settings.sharedReadOnly,
			BindOptions: { Propagation: "rprivate", NonRecursive: true },
		},
	];
	if (proxyPublic)
		mounts.push({
			Type: "bind",
			Source: proxyPublic,
			Target: "/run/pi-chat-proxy",
			ReadOnly: true,
			BindOptions: { Propagation: "rprivate", NonRecursive: true },
		});
	return {
		Image: settings.image,
		User: settings.user,
		WorkingDir: "/workspace",
		Env: CLEAN_ENV,
		Entrypoint: ["/usr/bin/python3", "-I", "/opt/pi-chat/entry.py"],
		Cmd: [],
		Labels: labels,
		HostConfig: {
			CapDrop: ["ALL"],
			CapAdd: [],
			Privileged: false,
			SecurityOpt: ["no-new-privileges:true"],
			ReadonlyRootfs: true,
			NetworkMode: "none",
			Runtime: settings.runtime,
			PidMode: "",
			IpcMode: "private",
			CgroupnsMode: "private",
			Init: true,
			Memory: settings.memoryMiB * 1048576,
			MemorySwap: settings.memoryMiB * 1048576,
			NanoCpus: Math.round(settings.cpus * 1e9),
			PidsLimit: settings.pidsLimit,
			Tmpfs: {
				"/tmp": `rw,nosuid,nodev,noexec,size=${settings.tmpfsMiB}m,mode=1777`,
				"/run": "rw,nosuid,nodev,noexec,size=16m,mode=755",
			},
			ShmSize: 16 * 1048576,
			Ulimits: [
				{ Name: "nofile", Soft: 1024, Hard: 1024 },
				{ Name: "core", Soft: 0, Hard: 0 },
			],
			RestartPolicy: { Name: "no" },
			AutoRemove: false,
			LogConfig: { Type: "none", Config: {} },
			Mounts: mounts,
		},
	};
}

export class DockerExecution implements ConversationExecution {
	readonly mode = "docker" as const;
	readonly workspacePath = "/workspace";
	readonly sharedPath = "/shared";
	private state: "new" | "starting" | "ready" | "idle-stopped" | "failed" | "closing" | "closed" = "new";
	private readonly settings: DockerSettings;
	private readonly directory: string;
	private readonly owner: string;
	private id?: string;
	private startPromise?: Promise<void>;
	private closePromise?: Promise<void>;
	private closing = false;
	private active = 0;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private idleDeadline?: number;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly transaction = new AsyncLocalStorage<boolean>();
	private currentAbort?: AbortController;
	private lease?: ChildProcess;
	private proxy?: DockerEgress;
	private lastError?: string;
	private fingerprint = "";
	private imageId = "";
	private spec?: ReturnType<typeof dockerCreateSpec>;
	constructor(
		private readonly context: DockerContext,
		private readonly client: DockerClient = new EngineClient(),
		private readonly egressFactory = (policy: DockerPolicy, directory: string, hold: () => () => void) =>
			new DockerEgress(policy, directory, hold),
	) {
		if (!context.docker || !context.dockerDir)
			throw new Error("Docker execution requires resolved settings and private metadata path");
		this.settings = resolveDockerSettings([context.docker], context.gondolinSecrets);
		this.directory = resolve(context.dockerDir);
		this.owner = digest(this.directory);
	}
	getStatus() {
		return {
			backend: "docker",
			state: this.state,
			container: this.id?.slice(0, 12),
			runtime: this.settings.runtime,
			image: this.settings.image,
			sharedReadOnly: this.settings.sharedReadOnly,
			network: this.settings.network.mode,
			allowedHosts: this.settings.network.allowedHosts.length,
			memoryMiB: this.settings.memoryMiB,
			cpus: this.settings.cpus,
			pidsLimit: this.settings.pidsLimit,
			onClose: this.settings.lifecycle.onClose,
			idleDeadline: this.idleDeadline,
			lastError: this.lastError,
		};
	}
	holdActivity(): () => void {
		if (this.closing) throw new Error("Docker backend is closed");
		this.active++;
		clearTimeout(this.idleTimer);
		this.idleDeadline = undefined;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.active--;
				this.scheduleIdle();
			}
		};
	}
	async withToolTransaction<T>(fn: () => Promise<T>): Promise<T> {
		if (this.transaction.getStore()) return fn();
		const release = this.holdActivity();
		const work = this.tail.then(() =>
			this.transaction.run(true, async () => {
				if (this.closing) throw new Error("Docker backend is closed");
				return fn();
			}),
		);
		this.tail = work.catch(() => undefined);
		try {
			return await work;
		} finally {
			release();
		}
	}
	private scheduleIdle(): void {
		if (this.closing || this.active || this.state !== "ready" || !this.settings.lifecycle.idleTimeoutSeconds) return;
		clearTimeout(this.idleTimer);
		const ms = this.settings.lifecycle.idleTimeoutSeconds * 1000;
		this.idleDeadline = performance.now() + ms;
		this.idleTimer = setTimeout(() => {
			const stop = this.tail.then(async () => {
				if (!this.active && !this.closing && this.state === "ready") await this.stop();
			});
			this.tail = stop.catch(() => {
				this.state = "failed";
				this.lastError = "Idle stop failed; cleanup required";
			});
		}, ms);
		this.idleTimer.unref();
	}
	start(): Promise<void> {
		if (this.closing) return Promise.reject(new Error("Docker backend closed"));
		if (this.state === "ready") return Promise.resolve();
		if (this.startPromise) return this.startPromise;
		if (this.state === "failed") return Promise.reject(new Error("Docker backend failed; disconnect and reconcile"));
		this.startPromise = this.startInternal().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}
	private fence(): void {
		if (this.closing) throw new Error("Docker start cancelled by close");
	}
	private async audit(event: string): Promise<void> {
		const path = join(this.directory, "execution.jsonl");
		if ((await stat(path).catch(() => undefined))?.size && (await stat(path)).size > 1048576)
			await rename(path, `${path}.1`);
		const line = JSON.stringify({
			event,
			state: this.state,
			owner: this.owner,
			container: this.id?.slice(0, 12),
			time: new Date().toISOString(),
		});
		await writeFile(path, `${line}\n`, { flag: "a", mode: 0o600 });
		console.error(`[pi-chat docker] ${line}`);
	}
	private async metadata(): Promise<void> {
		const path = join(this.directory, "session.json");
		await writeFile(
			`${path}.tmp`,
			JSON.stringify({
				id: this.id,
				owner: this.owner,
				fingerprint: this.fingerprint,
				imageId: this.imageId,
				state: this.state,
				updated: Date.now(),
			}),
			{ mode: 0o600 },
		);
		await rename(`${path}.tmp`, path);
	}
	private async paths(): Promise<void> {
		if (process.platform !== "linux") throw new Error("Docker v1 requires local Linux Engine");
		const uid = `${process.geteuid?.()}:${process.getegid?.()}`;
		if (this.settings.user !== uid || uid.startsWith("0:"))
			throw new Error("Docker v1 requires a dedicated non-root controller with matching UID:GID");
		for (const path of [this.context.workspaceDir, this.context.sharedDir, this.directory]) {
			if (!path.startsWith("/") || path.includes("\0")) throw new Error("Docker mount must be absolute");
			await mkdir(path, { recursive: true, mode: 0o700 });
			if ((await realpath(path)) !== resolve(path)) throw new Error("Docker mount aliases/symlinks rejected");
		}
		const roots = [this.context.workspaceDir, this.context.sharedDir];
		if (inside(roots[0], roots[1]) || inside(roots[1], roots[0]))
			throw new Error("Docker workspace/shared overlap rejected");
		const code = dirname(fileURLToPath(import.meta.url));
		for (const root of roots) {
			if (root === "/" || root === "/workspace" || root === homedir())
				throw new Error("Docker requires dedicated mount roots");
			for (const sensitive of [
				this.directory,
				code,
				join(homedir(), ".pi"),
				join(homedir(), ".ssh"),
				"/etc",
				"/proc",
				"/sys",
				"/dev",
				"/run",
				"/var/run",
				"/var/lib/docker",
			]) {
				// Normal channel workspaces may be children of ~/.pi, but never expose its parent.
				if (inside(root, sensitive) || (sensitive !== join(homedir(), ".pi") && inside(sensitive, root)))
					throw new Error("Docker sensitive/overlapping mount rejected");
			}
			let count = 0;
			const scan = async (path: string): Promise<void> => {
				if (++count > 100000) throw new Error("Docker mount inventory limit");
				for (const entry of await readdir(path, { withFileTypes: true })) {
					const p = join(path, entry.name);
					const info = await lstat(p);
					if (info.isSymbolicLink()) continue;
					if (info.isDirectory()) await scan(p);
					else if (!info.isFile() || info.nlink !== 1) throw new Error("Docker mount has special files or hardlinks");
				}
			};
			await scan(root);
		}
		await chmod(this.directory, 0o700);
		await mkdir(join(this.directory, "outgoing"), { recursive: true, mode: 0o700 });
		const locks = join(tmpdir(), `pi-chat-docker-${process.geteuid?.()}`);
		await mkdir(locks, { mode: 0o700, recursive: true });
		const info = await lstat(locks);
		if (!info.isDirectory() || info.uid !== process.geteuid?.() || info.mode & 0o077)
			throw new Error("Docker lease directory unsafe");
		await new Promise<void>((resolveLease, reject) => {
			const child = spawn(
				"/usr/bin/flock",
				[
					"-n",
					join(locks, digest(this.context.workspaceDir)),
					"/usr/bin/python3",
					"-I",
					"-c",
					"import sys; print('ready', flush=True); sys.stdin.read()",
				],
				{ env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] },
			);
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("Docker lease deadline"));
			}, 5000);
			child.once("error", () => {
				clearTimeout(timer);
				reject(new Error("Docker requires flock/Python lease helper"));
			});
			child.once("exit", () => {
				clearTimeout(timer);
				reject(new Error("Docker workspace already owned"));
				if (this.lease === child && !this.closing) {
					this.state = "failed";
					this.currentAbort?.abort();
				}
			});
			child.stdout?.once("data", () => {
				clearTimeout(timer);
				this.lease = child;
				resolveLease();
			});
		});
	}
	private async preflight(): Promise<void> {
		if (this.client instanceof EngineClient) await this.client.negotiate();
		const info = await this.client.json<{
			OSType: string;
			SecurityOptions: string[];
			Runtimes: Record<string, unknown>;
			MemoryLimit: boolean;
			SwapLimit: boolean;
			CpuCfsQuota: boolean;
			PidsLimit: boolean;
		}>("GET", "/info");
		if (
			info.OSType !== "linux" ||
			!info.MemoryLimit ||
			!info.SwapLimit ||
			!info.CpuCfsQuota ||
			!info.PidsLimit ||
			!info.SecurityOptions.some((s) => s.startsWith("name=seccomp")) ||
			info.SecurityOptions.some((s) => /rootless|userns/.test(s)) ||
			!info.Runtimes[this.settings.runtime]
		)
			throw new Error("Docker security/resource/runtime prerequisites unavailable");
		let image: ImageInfo;
		try {
			image = await this.client.json("GET", `/images/${encodeURIComponent(this.settings.image)}/json`);
		} catch (error) {
			if (!(error instanceof DockerError) || error.status !== 404 || this.settings.pullPolicy !== "if-missing")
				throw error;
			await this.client.json(
				"POST",
				`/images/create?fromImage=${encodeURIComponent(this.settings.image)}`,
				undefined,
				120000,
			);
			image = await this.client.json("GET", `/images/${encodeURIComponent(this.settings.image)}/json`);
		}
		if (
			image.Os !== "linux" ||
			image.Architecture !== (process.arch === "x64" ? "amd64" : process.arch) ||
			!image.RepoDigests?.includes(this.settings.image) ||
			image.Config.Labels?.["org.pi-chat.helper"] !== "1" ||
			JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(["/usr/bin/python3", "-I", "/opt/pi-chat/entry.py"]) ||
			image.Config.Cmd?.length ||
			Object.keys(image.Config.Volumes ?? {}).length ||
			image.Config.OnBuild?.length ||
			image.Config.Env?.some((v) => !v.startsWith("PATH="))
		)
			throw new Error("Docker image does not implement trusted helper protocol 1");
		this.imageId = image.Id;
	}
	private async startInternal(): Promise<void> {
		const waking = this.state === "idle-stopped";
		this.state = "starting";
		try {
			if (!waking) {
				await this.paths();
				this.fence();
				await this.preflight();
				this.fence();
				if (this.settings.network.mode === "proxy") {
					this.proxy = this.egressFactory(
						new DockerPolicy(this.settings.network, this.context.gondolinSecrets),
						this.directory,
						() => this.holdActivity(),
					);
					await this.proxy.start();
					this.fence();
				}
				this.fingerprint = digest({
					settings: this.settings,
					workspace: this.context.workspaceDir,
					shared: this.context.sharedDir,
					imageId: this.imageId,
				});
				const labels = {
					"org.pi-chat.managed": "1",
					"org.pi-chat.owner": this.owner,
					"org.pi-chat.fingerprint": this.fingerprint,
				};
				this.spec = dockerCreateSpec(this.context, this.settings, labels, this.proxy?.publicDir);
				const candidates = await this.client.json<Array<{ Id: string }>>(
					"GET",
					`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`org.pi-chat.owner=${this.owner}`, "org.pi-chat.managed=1"] }))}`,
				);
				for (const candidate of candidates) {
					const existing = await this.inspect(candidate.Id);
					if (existing.Config.Labels["org.pi-chat.owner"] !== this.owner) throw new Error("Docker ownership mismatch");
					if (existing.State.Running) await this.client.json("POST", `/containers/${candidate.Id}/stop?t=2`);
					let reusable = false;
					try {
						const meta = JSON.parse(await readFile(join(this.directory, "session.json"), "utf8")) as {
							id: string;
							updated: number;
						};
						reusable =
							!existing.State.Running &&
							meta.id === candidate.Id &&
							Date.now() - meta.updated < this.settings.lifecycle.retainedTtlSeconds * 1000 &&
							this.matches(existing);
					} catch {
						/* Missing metadata means recreate, not adoption. */
					}
					if (reusable && !this.id) this.id = candidate.Id;
					else await this.client.json("DELETE", `/containers/${candidate.Id}?force=1`);
				}
				this.fence();
				if (!this.id) {
					const name = `pi-chat-${this.owner.slice(0, 12)}-${randomUUID()}`;
					await this.metadata();
					const created = await this.client.json<{ Id: string }>("POST", `/containers/create?name=${name}`, this.spec);
					this.id = created.Id;
					await this.metadata();
				}
			}
			this.fence();
			await this.client.json("POST", `/containers/${this.id}/start`);
			this.fence();
			const inspect = await this.inspect();
			if (!inspect.State.Running || !this.matches(inspect)) throw new Error("Docker effective hardening mismatch");
			await this.probe();
			this.fence();
			this.state = "ready";
			await this.metadata();
			await this.audit(waking ? "wake" : "ready");
			this.scheduleIdle();
		} catch (error) {
			this.state = "failed";
			this.lastError = error instanceof Error ? error.message : "Docker startup failed";
			try {
				if (this.lease && !this.id) {
					const owned = await this.client.json<Array<{ Id: string }>>(
						"GET",
						`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`org.pi-chat.owner=${this.owner}`, "org.pi-chat.managed=1"] }))}`,
					);
					for (const item of owned) {
						const inspect = await this.inspect(item.Id);
						if (inspect.Config.Labels["org.pi-chat.owner"] !== this.owner) throw new Error("ownership mismatch");
						await this.client.json("DELETE", `/containers/${item.Id}?force=1`);
					}
				}
				await this.destroy();
			} catch {
				this.lastError += "; cleanup incomplete, retain metadata";
			}
			throw new Error(this.lastError);
		}
	}
	private inspect(id = this.id): Promise<Inspection> {
		return this.client.json("GET", `/containers/${id}/json`);
	}
	private matches(i: Inspection): boolean {
		if (
			!this.spec ||
			i.Image !== this.imageId ||
			i.Config.User !== this.settings.user ||
			i.Config.Labels["org.pi-chat.fingerprint"] !== this.fingerprint
		)
			return false;
		for (const key of [
			"CapDrop",
			"Privileged",
			"ReadonlyRootfs",
			"NetworkMode",
			"Runtime",
			"Memory",
			"MemorySwap",
			"NanoCpus",
			"PidsLimit",
			"CgroupnsMode",
			"Init",
			"ShmSize",
			"Tmpfs",
			"SecurityOpt",
		]) {
			if (!isDeepStrictEqual(i.HostConfig[key], (this.spec.HostConfig as Record<string, unknown>)[key])) return false;
		}
		if (
			(i.HostConfig.CapAdd as unknown[] | null)?.length ||
			(i.HostConfig.Devices as unknown[] | null)?.length ||
			(i.HostConfig.GroupAdd as unknown[] | null)?.length ||
			Object.keys(i.HostConfig.PortBindings ?? {}).length ||
			i.HostConfig.PublishAllPorts ||
			i.HostConfig.OomKillDisable ||
			i.HostConfig.PidMode === "host" ||
			i.HostConfig.IpcMode !== "private" ||
			i.Mounts.filter((m) => m.Propagation).length !== this.spec.HostConfig.Mounts.length
		)
			return false;
		return this.spec.HostConfig.Mounts.every((m) =>
			i.Mounts.some(
				(actual) =>
					actual.Source === m.Source &&
					actual.Destination === m.Target &&
					actual.RW === !m.ReadOnly &&
					actual.Propagation === "rprivate",
			),
		);
	}
	private async probe(): Promise<void> {
		const code =
			"import os,socket,time; time.sleep(0.15); assert os.getuid()!=0; assert os.path.isfile('/opt/pi-chat/files.py'); p='/workspace/.pi-chat-probe'; f=open(p,'w'); f.close(); os.unlink(p)" +
			(this.proxy ? "; s=socket.create_connection(('127.0.0.1',18080),3); s.close()" : "");
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 10000);
		try {
			const exit = await this.rawExec(
				["/usr/bin/python3", "-I", "-c", code],
				undefined,
				() => undefined,
				abort.signal,
				"/workspace",
			);
			if (exit !== 0) throw new Error("Docker readiness failed (UID/mount/helper/proxy)");
		} finally {
			clearTimeout(timer);
		}
	}
	private async rawExec(
		cmd: string[],
		input: Buffer | undefined,
		onData: (data: Buffer, stream: number) => void,
		signal: AbortSignal,
		cwd: string,
	): Promise<number> {
		if (signal.aborted) throw new Error("aborted");
		const env = [...CLEAN_ENV, ...Object.entries(this.proxy?.env ?? {}).map(([k, v]) => `${k}=${v}`)];
		const created = await this.client.json<{ Id: string }>("POST", `/containers/${this.id}/exec`, {
			Cmd: ["/usr/bin/env", "-i", ...env, ...cmd],
			User: this.settings.user,
			WorkingDir: cwd,
			Tty: false,
			AttachStdout: true,
			AttachStderr: true,
			AttachStdin: input !== undefined,
			Privileged: false,
		});
		if (signal.aborted) throw new Error("aborted");
		await this.client.exec(created.Id, input, onData, signal);
		const result = await this.client.json<{ Running: boolean; ExitCode: number | null }>(
			"GET",
			`/exec/${created.Id}/json`,
		);
		if (signal.aborted) throw new Error("aborted");
		if (result.Running || !Number.isInteger(result.ExitCode)) throw new Error("Docker exec outcome unknown");
		return result.ExitCode as number;
	}
	private async run(
		cmd: string[],
		input: Buffer | undefined,
		onData: (data: Buffer, stream: number) => void,
		options: { signal?: AbortSignal; timeout?: number; limit?: number; cwd?: string } = {},
	): Promise<number> {
		return this.withToolTransaction(async () => {
			if (options.signal?.aborted) throw new Error("aborted");
			if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
				throw new Error("Docker timeout must be positive seconds");
			await this.start();
			if (!(await this.inspect()).State.Running) {
				this.state = "failed";
				throw new Error("Docker container unexpectedly exited; reconnect required");
			}
			const controller = new AbortController();
			this.currentAbort = controller;
			let reason: string | undefined;
			const abort = () => {
				reason = "aborted";
				controller.abort();
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			const timer = options.timeout
				? setTimeout(() => {
						reason = `timeout:${options.timeout}`;
						controller.abort();
					}, options.timeout * 1000)
				: undefined;
			let size = 0;
			try {
				const code = await this.rawExec(
					cmd,
					input,
					(data, stream) => {
						size += data.length;
						if (size > (options.limit ?? OUTPUT_LIMIT)) {
							reason = "Docker output limit exceeded";
							controller.abort();
							throw new Error(reason);
						}
						onData(data, stream);
					},
					controller.signal,
					options.cwd ?? "/workspace",
				);
				if (controller.signal.aborted) throw new Error(reason ?? "aborted");
				return code;
			} catch (error) {
				try {
					await this.stop();
				} catch {
					this.state = "failed";
					this.lastError = "Docker cannot confirm process termination; cleanup required";
					throw new Error(this.lastError);
				}
				throw new Error(
					reason ?? (this.closing ? "aborted" : error instanceof Error ? error.message : "Docker execution failed"),
				);
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				this.currentAbort = undefined;
			}
		});
	}
	private async stop(): Promise<void> {
		this.proxy?.revoke();
		if (this.id) {
			try {
				await this.client.json("POST", `/containers/${this.id}/stop?t=2`);
			} catch (error) {
				if (!(error instanceof DockerError && error.status === 304))
					await this.client.json("POST", `/containers/${this.id}/kill`);
			}
			if ((await this.inspect()).State.Running) throw new Error("Docker stop unconfirmed");
		}
		this.state = "idle-stopped";
		await this.metadata();
		await this.audit("stop");
	}
	private async destroy(): Promise<void> {
		await this.proxy?.close();
		this.proxy = undefined;
		if (this.id) {
			try {
				await this.client.json("DELETE", `/containers/${this.id}?force=1`);
			} catch (error) {
				if (!(error instanceof DockerError && error.status === 404)) throw error;
			}
			this.id = undefined;
		}
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		clearTimeout(this.idleTimer);
		this.currentAbort?.abort();
		this.closePromise = (async () => {
			try {
				await this.startPromise?.catch(() => undefined);
				await this.tail;
				this.state = "closing";
				if (this.id && this.settings.lifecycle.onClose === "stop") {
					await this.stop();
					await this.proxy?.close();
				} else await this.destroy();
				this.state = "closed";
				if (this.lease) {
					await this.metadata();
					await this.audit("closed");
				}
			} catch {
				this.state = "failed";
				this.lastError = "Docker close failed; managed container cleanup required";
				throw new Error(this.lastError);
			} finally {
				const lease = this.lease;
				this.lease = undefined;
				if (lease && lease.exitCode === null)
					await new Promise<void>((resolveLease) => {
						const timer = setTimeout(() => {
							lease.kill("SIGKILL");
							resolveLease();
						}, 2000);
						lease.once("exit", () => {
							clearTimeout(timer);
							resolveLease();
						});
						lease.stdin?.end();
					});
			}
		})();
		return this.closePromise;
	}
	private async file(op: string, path: string, content?: Buffer): Promise<Buffer> {
		const p = dockerPath(path, ["write", "mkdir", "edit-access"].includes(op), this.settings.sharedReadOnly);
		if ((content?.length ?? 0) > FILE_LIMIT) throw new Error("Docker file limit");
		const chunks: Buffer[] = [];
		const code = await this.run(
			["/usr/bin/python3", "-I", "/opt/pi-chat/files.py", op, p.root, p.relative],
			content,
			(chunk, stream) => {
				if (stream === 1) chunks.push(Buffer.from(chunk));
			},
			{ timeout: 30, limit: FILE_LIMIT },
		);
		if (code !== 0) throw new Error("Docker file operation rejected (path, permissions, links, type or size)");
		return Buffer.concat(chunks);
	}
	async createReadOperations(): Promise<ReadOperations> {
		return {
			readFile: (p) => this.file("read", p),
			access: async (p) => {
				await this.file("access", p);
			},
			detectImageMimeType: async (p) =>
				({
					".png": "image/png",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".gif": "image/gif",
					".webp": "image/webp",
				})[extname(p).toLowerCase()] ?? null,
		};
	}
	async createWriteOperations(): Promise<WriteOperations> {
		return {
			writeFile: async (p, content) => {
				await this.file("write", p, Buffer.from(content));
			},
			mkdir: async (p) => {
				await this.file("mkdir", p);
			},
		};
	}
	async createEditOperations(): Promise<EditOperations> {
		return {
			readFile: (p) => this.file("read", p),
			access: async (p) => {
				await this.file("edit-access", p);
			},
			writeFile: async (p, content) => {
				await this.file("write", p, Buffer.from(content));
			},
		};
	}
	async createBashOperations(): Promise<BashOperations> {
		return {
			exec: async (command, cwd, options) => ({
				exitCode: await this.run(["/bin/bash", "--noprofile", "--norc", "-c", command], undefined, options.onData, {
					...options,
					cwd: dockerPath(cwd).path,
				}),
			}),
		};
	}
	async stageAttachment(path: string): Promise<string> {
		return this.withToolTransaction(async () => {
			const outgoing = join(this.directory, "outgoing");
			const files = await readdir(outgoing);
			let total = 0;
			for (const file of files) {
				const p = join(outgoing, file);
				const s = await stat(p);
				if (Date.now() - s.mtimeMs > 86400000) await rm(p);
				else total += s.size;
			}
			if (total > 200 * 1048576 || files.length > 256) throw new Error("Docker outgoing staging budget exceeded");
			const data = await this.file("read", path);
			const target = join(outgoing, `${randomUUID()}-${basename(path).replace(/[^a-zA-Z0-9._-]/g, "_")}`);
			await writeFile(target, data, { flag: "wx", mode: 0o600 });
			return target;
		});
	}
}
