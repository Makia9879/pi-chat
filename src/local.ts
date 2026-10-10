import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import type { ResolvedConversation } from "./core/config-types.js";
import type { ConversationExecution } from "./execution.js";

/** Explicitly unsandboxed: filesystem tools have the host user's permissions. */
export class LocalExecution implements ConversationExecution {
	private closed = false;
	private ready = false;
	private failure: Error | undefined;
	private children = new Map<ChildProcess, Promise<void>>();

	readonly mode = "local" as const;
	get workspacePath(): string {
		return this.conversation.workspaceDir;
	}
	get sharedPath(): string {
		return this.conversation.sharedDir;
	}

	constructor(
		readonly conversation: Pick<
			ResolvedConversation,
			"workspaceDir" | "sharedDir" | "conversationDir" | "gondolinSecrets"
		>,
	) {}

	async start(): Promise<void> {
		if (this.closed) throw new Error("Local execution is closed");
		if (this.failure) throw this.failure;
		if (this.ready) return;
		try {
			if (Object.keys(this.conversation.gondolinSecrets).length)
				throw new Error("Gondolin HTTP-hook secrets cannot be used in local mode. Remove them or use Gondolin.");
			await Promise.all(
				[this.conversation.workspaceDir, this.conversation.sharedDir, this.conversation.conversationDir].map((dir) =>
					mkdir(dir, { recursive: true }),
				),
			);
			this.ready = true;
		} catch (error) {
			this.failure = error instanceof Error ? error : new Error(String(error));
			throw this.failure;
		}
	}

	private assertReady(): void {
		if (this.failure) throw this.failure;
		if (this.closed || !this.ready) throw new Error("Local execution is not ready");
	}

	private kill(child: ChildProcess): void {
		try {
			if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			// The process may already have exited.
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const child of this.children.keys()) this.kill(child);
		await Promise.all(this.children.values());
	}

	async createReadOperations() {
		this.assertReady();
		return undefined;
	}
	async createWriteOperations() {
		this.assertReady();
		return undefined;
	}
	async createEditOperations() {
		this.assertReady();
		return undefined;
	}

	async stageAttachment(inputPath: string): Promise<string> {
		this.assertReady();
		const source = await realpath(resolve(this.conversation.workspaceDir, inputPath));
		const roots = await Promise.all(
			[this.conversation.workspaceDir, this.conversation.sharedDir].map((p) => realpath(p)),
		);
		if (
			!roots.some((root) => {
				const rel = relative(root, source);
				return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
			})
		)
			throw new Error("Attachments must be inside the workspace or account shared directory");
		const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			if (!(await handle.stat()).isFile()) throw new Error(`Not a file: ${inputPath}`);
			const dir = join(this.conversation.conversationDir, "outgoing");
			await mkdir(dir, { recursive: true });
			const target = join(dir, `${randomUUID()}-${basename(source)}`);
			await writeFile(target, await handle.readFile(), { flag: "wx" });
			return target;
		} finally {
			await handle.close();
		}
	}

	async createBashOperations(): Promise<BashOperations> {
		this.assertReady();
		return {
			exec: (command, cwd, options) =>
				new Promise((resolveResult, reject) => {
					if (this.failure) {
						reject(this.failure);
						return;
					}
					if (this.closed || !this.ready || options.signal?.aborted) {
						reject(new Error(this.ready ? "aborted" : "Local execution is not ready"));
						return;
					}
					// Do not inherit API keys or tokens from the pi process. This is not a security boundary.
					// Processes that daemonize or leave this process group are not tracked after the shell exits.
					const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
						cwd,
						env: {
							PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
							HOME: this.conversation.workspaceDir,
							LANG: "C.UTF-8",
						},
						detached: process.platform !== "win32",
						stdio: ["ignore", "pipe", "pipe"],
					});
					let finished!: () => void;
					this.children.set(
						child,
						new Promise<void>((r) => {
							finished = r;
						}),
					);
					let timedOut = false;
					let settled = false;
					const settle = (fn: () => void) => {
						if (settled) return;
						settled = true;
						fn();
					};
					const onAbort = () => this.kill(child);
					const timer =
						options.timeout && options.timeout > 0
							? setTimeout(() => {
									timedOut = true;
									this.kill(child);
								}, options.timeout * 1000)
							: undefined;
					options.signal?.addEventListener("abort", onAbort, { once: true });
					child.stdout?.on("data", options.onData);
					child.stderr?.on("data", options.onData);
					child.on("error", (error) => {
						if (timer) clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						this.children.delete(child);
						finished();
						settle(() => reject(error));
					});
					child.on("close", (code) => {
						if (timer) clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						this.children.delete(child);
						finished();
						settle(() => {
							if (timedOut) reject(new Error(`timeout:${options.timeout}`));
							else if (options.signal?.aborted || this.closed) reject(new Error("aborted"));
							else resolveResult({ exitCode: code });
						});
					});
					if (options.signal?.aborted) onAbort();
				}),
		};
	}
}
