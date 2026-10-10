import type { ConversationExecution } from "./execution.js";

/** Support both legacy pi cwd text and newer structured-prompt serialization. */
export function executionSystemPrompt(
	prompt: string,
	cwd: string,
	execution: Pick<ConversationExecution, "workspacePath" | "sharedPath" | "mode">,
): string {
	return `${prompt
		.replace(`Current working directory: ${cwd}`, `Current working directory: ${execution.workspacePath}`)
		.replace(
			`<cwd>\n${cwd}\n</cwd>`,
			`<cwd>\n${execution.workspacePath}\n</cwd>`,
		)}\n\npi-chat tool environment: ${execution.mode === "local" ? "local host processes (NOT sandboxed)" : "Gondolin VM"}. Working directory: ${execution.workspacePath}. Shared files: ${execution.sharedPath}.`;
}
