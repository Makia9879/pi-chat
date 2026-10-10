import type { ResolvedConversation } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";

export interface LiveConnectionHandlers {
	onMessage(input: InboundMessageInput, checkpoint?: { cursor?: string; messageId?: string }): Promise<void>;
	onCaughtUp(): Promise<void>;
	onError(error: Error): Promise<void>;
	onDisconnect?(): Promise<void>;
}

export interface ResumeState {
	cursor?: string;
	messageId?: string;
}

/** Turn result for optional platform status badges. Success adds no badge. */
export type LiveProcessingOutcome = "success" | "failure" | "cancelled";

export interface LiveConnection {
	conversation: ResolvedConversation;
	disconnect(): Promise<void>;
	sendImmediate(text: string, replyToMessageId?: string): Promise<string | undefined>;
	send(
		text: string,
		attachmentPaths?: string[],
		signal?: AbortSignal,
		replyToMessageId?: string,
	): Promise<string | undefined>;
	startTyping(status?: string): Promise<void>;
	stopTyping(): Promise<void>;
	syncPreview(markdown: string, done?: boolean): Promise<string[]>;
	clearPreview(): Promise<void>;
	setReplyTo(messageId: string | undefined): void;
	/**
	 * Optional status badge after the typing indicator is cleared.
	 * Feishu adds a failure emoji only when the in-progress reaction was deleted.
	 * Abort/cancel only deletes. Success adds nothing.
	 */
	markOutcome?(messageId: string | undefined, outcome: LiveProcessingOutcome): Promise<void>;
}
