import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@mariozechner/pi-coding-agent";
import type { ResolvedConversation } from "./core/config-types.js";

/** The agent runs in pi; this backend selects where its tools execute. */
export interface ConversationExecution {
	readonly workspacePath: string;
	readonly sharedPath: string;
	readonly mode: "gondolin" | "local";
	start(): Promise<unknown>;
	close(): Promise<void>;
	stageAttachment(path: string): Promise<string>;
	createReadOperations(): Promise<ReadOperations | undefined>;
	createWriteOperations(): Promise<WriteOperations | undefined>;
	createEditOperations(): Promise<EditOperations | undefined>;
	createBashOperations(): Promise<BashOperations>;
}

export async function createConversationExecution(conversation: ResolvedConversation): Promise<ConversationExecution> {
	if (conversation.runtimeMode === "local") {
		const { LocalExecution } = await import("./local.js");
		return new LocalExecution(conversation);
	}
	const { ConversationSandbox } = await import("./gondolin.js");
	return new ConversationSandbox(conversation);
}

export function displayPath(conversation: ResolvedConversation, hostPath: string): string {
	for (const [root, target] of [
		[conversation.workspaceDir, conversation.workspacePath],
		[conversation.sharedDir, conversation.sharedPath],
	]) {
		if (hostPath === root) return target;
		if (hostPath.startsWith(`${root}/`)) return `${target}/${hostPath.slice(root.length + 1)}`;
	}
	return hostPath;
}
