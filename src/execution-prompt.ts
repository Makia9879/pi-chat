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
		)}\n\npi-chat tool environment: ${execution.mode === "local" ? "local host processes (NOT sandboxed)" : execution.mode === "docker" ? "Docker container (not a microVM), non-root, read-only root filesystem, network-none; optional host-policy HTTP(S) proxy. Do not install system packages. Cancellation and idle stop kill all background processes. Treat /shared as read-only unless explicitly configured otherwise" : "Gondolin VM"}. Working directory: ${execution.workspacePath}. Shared files: ${execution.sharedPath}.`;
}
