import type { ResolvedConversation } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";

export interface LiveConnectionEvent {
	type: string;
	message: string;
}

export interface LiveConnectionStatus {
	state: string;
	lastActivityAt?: string;
	reconnectCount: number;
	nextReconnectAt?: string;
	lastDisconnectReason?: string;
}

export interface LiveConnectionHandlers {
	onMessage(input: InboundMessageInput, checkpoint?: { cursor?: string; messageId?: string }): Promise<void>;
	onCaughtUp(): Promise<void>;
	onError(error: Error): Promise<void>;
	onDisconnect?(): Promise<void>;
	/** Link lifecycle. Feishu uses this for connect, disconnect, and reconnect. */
	onConnectionEvent?(event: LiveConnectionEvent): Promise<void> | void;
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
	/** Present for Feishu WebSocket. HTTP callbacks and other services omit it. */
	connectionStatus?(): LiveConnectionStatus;
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
	/** Feishu post/markdown reply. Other services omit this and use sendImmediate. */
	sendRich?(markdown: string, replyToMessageId?: string): Promise<string | undefined>;
	/** Feishu interactive card with numbered buttons. Falls back to text if the card API rejects it. */
	sendChoiceCard?(
		title: string,
		markdown: string,
		buttons: Array<{ label: string; value: string }>,
		replyToMessageId?: string,
	): Promise<string | undefined>;
}
