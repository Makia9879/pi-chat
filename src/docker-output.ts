import { randomUUID } from "node:crypto";
import { createBashTool, truncateTail } from "@mariozechner/pi-coding-agent";
import type { ConversationExecution } from "./execution.js";

/** Bounded memory collector; never invokes pi's host spill-file implementation. */
export async function dockerBashTool(execution: ConversationExecution) {
	const tool = createBashTool(execution.workspacePath);
	const ops = await execution.createBashOperations();
	return {
		...tool,
		execute: async (...args: Parameters<typeof tool.execute>) => {
			const [, params, signal, onUpdate] = args;
			const chunks: Buffer[] = [];
			let total = 0;
			let lastUpdate = 0;
			let failure: string | undefined;
			let exitCode: number | null = null;
			try {
				({ exitCode } = await ops.exec(params.command, execution.workspacePath, {
					signal,
					timeout: params.timeout,
					onData(data) {
						total += data.length;
						if (total > 16 * 1048576) throw new Error("Docker output limit exceeded");
						chunks.push(Buffer.from(data));
						if (onUpdate && performance.now() - lastUpdate > 100) {
							lastUpdate = performance.now();
							const text = truncateTail(Buffer.concat(chunks).toString("utf8"));
							onUpdate({ content: [{ type: "text", text: text.content }], details: undefined });
						}
					},
				}));
			} catch (error) {
				failure = error instanceof Error ? error.message : "Docker execution failed";
			}
			const bytes = Buffer.concat(chunks);
			const truncation = truncateTail(bytes.toString("utf8"));
			let text = truncation.content || "(no output)";
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				const write = await execution.createWriteOperations();
				if (!write) throw new Error("Docker output requires a safe file bridge");
				fullOutputPath = `/workspace/.pi-chat-output/${randomUUID()}.log`;
				try {
					await write.mkdir("/workspace/.pi-chat-output");
					await write.writeFile(fullOutputPath, bytes.toString("utf8"));
					text += `\n\n[Output truncated. Full output: ${fullOutputPath}]`;
				} catch {
					fullOutputPath = undefined;
					text += "\n\n[Full output unavailable: backend closed or file bridge rejected write]";
				}
			}
			const details = { truncation: truncation.truncated ? truncation : undefined, fullOutputPath };
			if (failure || exitCode !== 0) {
				const reason =
					failure === "aborted"
						? "Command aborted"
						: failure?.startsWith("timeout:")
							? `Command timed out after ${failure.slice(8)} seconds`
							: (failure ?? `Command exited with code ${exitCode}`);
				text += `\n\n${reason}. Bind-mounted side effects are not rolled back.`;
				onUpdate?.({ content: [{ type: "text", text }], details });
				throw new Error(text);
			}
			return { content: [{ type: "text" as const, text }], details };
		},
	};
}
