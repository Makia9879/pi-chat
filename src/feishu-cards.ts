/** Card and post helpers aligned with Hermes `plugins/platforms/feishu/adapter.py`. */

export const FEISHU_CARD_DEDUP_TTL_MS = 15 * 60 * 1000;

export function feishuPostBody(markdown: string): {
	zh_cn: { content: Array<Array<{ tag: "md"; text: string }>> };
} {
	const content = markdown.replace(/\r\n/g, "\n").trim();
	if (!content) return { zh_cn: { content: [[{ tag: "md", text: "" }]] } };
	const rows: Array<Array<{ tag: "md"; text: string }>> = [];
	const parts = content.split(/```/);
	for (let index = 0; index < parts.length; index++) {
		const segment = parts[index] ?? "";
		if (index % 2 === 1) {
			rows.push([{ tag: "md", text: `\`\`\`${segment}\`\`\`` }]);
			continue;
		}
		for (const line of segment.split("\n")) {
			if (!line.trim()) continue;
			rows.push([{ tag: "md", text: line }]);
		}
	}
	return { zh_cn: { content: rows.length > 0 ? rows : [[{ tag: "md", text: content }]] } };
}

export function feishuChoiceCard(
	title: string,
	markdown: string,
	buttons: readonly { label: string; value: string }[],
): Record<string, unknown> {
	const elements: Array<Record<string, unknown>> = [{ tag: "markdown", content: markdown }];
	if (buttons.length > 0) {
		elements.push({
			tag: "action",
			actions: buttons.map((button) => ({
				tag: "button",
				text: { tag: "plain_text", content: button.label },
				type: "default",
				value: { pi_chat_select: button.value },
			})),
		});
	}
	return {
		config: { wide_screen_mode: true },
		header: { title: { content: title, tag: "plain_text" }, template: "blue" },
		elements,
	};
}

/** Returns false when this card action token was already accepted inside the Hermes 15-minute window. */
export function consumeCardActionToken(seen: Map<string, number>, token: string, now = Date.now()): boolean {
	for (const [key, seenAt] of seen) {
		if (now - seenAt > FEISHU_CARD_DEDUP_TTL_MS) seen.delete(key);
	}
	if (!token) return true;
	if (seen.has(token)) return false;
	seen.set(token, now);
	return true;
}

export function feishuCardSelection(data: {
	event_type?: string;
	header?: { event_type?: string };
	operator?: { open_id?: string };
	action?: { value?: { pi_chat_select?: string } | string };
	token?: string;
	event?: {
		operator?: { open_id?: string };
		action?: { value?: { pi_chat_select?: string } };
		token?: string;
	};
}): { userId: string; index: number; token: string } | undefined {
	const eventType = data.header?.event_type ?? data.event_type;
	if (eventType !== "card.action.trigger") return undefined;
	const operator = data.operator?.open_id ?? data.event?.operator?.open_id;
	const value = data.action?.value ?? data.event?.action?.value;
	const selected = value && typeof value === "object" ? value.pi_chat_select : undefined;
	const token = data.token ?? data.event?.token ?? "";
	const index = Number(selected);
	if (!operator || !Number.isInteger(index) || index < 1) return undefined;
	return { userId: operator, index, token };
}
