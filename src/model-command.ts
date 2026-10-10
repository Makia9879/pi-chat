export const CHAT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChatThinkingLevel = (typeof CHAT_THINKING_LEVELS)[number];

export interface ChatModelRef {
	provider: string;
	id: string;
	name?: string;
}

export type ResolvedChatModel<T extends ChatModelRef> = {
	ok: true;
	model: T;
	thinkingLevel?: ChatThinkingLevel;
};

export type ChatModelResolution<T extends ChatModelRef> = ResolvedChatModel<T> | { ok: false; text: string };

const THINKING = new Set<string>(CHAT_THINKING_LEVELS);

export function modelRef(model: ChatModelRef): string {
	return `${model.provider}/${model.id}`;
}

export function formatModelList(options: {
	current?: ChatModelRef;
	thinking?: string;
	models: readonly ChatModelRef[];
	scoped?: boolean;
}): string {
	const lines = [
		options.current ? `Current: ${modelRef(options.current)}` : "Current: none",
		`Thinking: ${options.thinking || "off"}`,
		"",
	];
	if (options.models.length === 0) {
		lines.push(
			options.scoped
				? "No authenticated models are in this session's model scope."
				: "No authenticated models are available. Configure a provider in pi, then send /model again.",
		);
		return lines.join("\n");
	}
	lines.push(options.scoped ? "Available (session scope):" : "Available:");
	const sorted = [...options.models].sort((a, b) => modelRef(a).localeCompare(modelRef(b)));
	for (const model of sorted) lines.push(`- ${modelRef(model)}`);
	lines.push("", "Switch with /model <provider/id> or /model <id>[:thinking].");
	return lines.join("\n");
}

export function formatModelSwitch(model: ChatModelRef, thinking: string, requested?: ChatThinkingLevel): string {
	const lines = [`Switched to ${modelRef(model)}.`];
	if (requested && requested !== thinking)
		lines.push(`Thinking: ${thinking} (requested ${requested}; clamped to the model).`);
	else lines.push(`Thinking: ${thinking}`);
	return lines.join("\n");
}

export function resolveChatModel<T extends ChatModelRef>(
	pattern: string,
	models: readonly T[],
): ChatModelResolution<T> {
	const trimmed = pattern.trim();
	if (!trimmed) return { ok: false, text: "Send /model to list models, or /model <provider/id>[:thinking] to switch." };
	const exact = exactMatches(trimmed, models);
	if (exact.length === 1) return { ok: true, model: exact[0] };
	if (exact.length > 1) return { ok: false, text: ambiguous(trimmed, exact) };
	const partial = partialMatches(trimmed, models);
	if (partial.length === 1) return { ok: true, model: partial[0] };
	if (partial.length > 1) return { ok: false, text: ambiguous(trimmed, partial) };
	const split = splitThinking(trimmed);
	if (split?.thinkingLevel) {
		const nested = resolveChatModel(split.modelPattern, models);
		if (!nested.ok) return nested;
		return { ok: true, model: nested.model, thinkingLevel: nested.thinkingLevel ?? split.thinkingLevel };
	}
	if (split?.invalidThinking && uniqueMatch(split.modelPattern, models)) {
		return {
			ok: false,
			text: `Unknown thinking level "${split.invalidThinking}".\nUse ${CHAT_THINKING_LEVELS.join(", ")}.`,
		};
	}
	return { ok: false, text: unknownModel(trimmed, models) };
}

function uniqueMatch<T extends ChatModelRef>(pattern: string, models: readonly T[]): boolean {
	const exact = exactMatches(pattern, models);
	if (exact.length === 1) return true;
	return exact.length === 0 && partialMatches(pattern, models).length === 1;
}

function exactMatches<T extends ChatModelRef>(pattern: string, models: readonly T[]): T[] {
	const canonical = models.filter((model) => same(modelRef(model), pattern));
	if (canonical.length > 0) return canonical;
	const slash = pattern.indexOf("/");
	if (slash !== -1) {
		const provider = pattern.slice(0, slash).trim();
		const id = pattern.slice(slash + 1).trim();
		if (!provider || !id) return [];
		return models.filter((model) => same(model.provider, provider) && same(model.id, id));
	}
	return models.filter((model) => same(model.id, pattern));
}

function partialMatches<T extends ChatModelRef>(pattern: string, models: readonly T[]): T[] {
	const needle = pattern.toLowerCase();
	if (!needle) return [];
	return models.filter((model) => {
		const ref = modelRef(model).toLowerCase();
		return (
			model.id.toLowerCase().includes(needle) || ref.includes(needle) || model.name?.toLowerCase().includes(needle)
		);
	});
}

function splitThinking(
	pattern: string,
): { modelPattern: string; thinkingLevel?: ChatThinkingLevel; invalidThinking?: string } | undefined {
	const index = pattern.lastIndexOf(":");
	if (index <= 0 || index === pattern.length - 1) return undefined;
	const modelPattern = pattern.slice(0, index).trim();
	const suffix = pattern.slice(index + 1).trim();
	if (!modelPattern || !suffix) return undefined;
	if (THINKING.has(suffix.toLowerCase())) {
		return { modelPattern, thinkingLevel: suffix.toLowerCase() as ChatThinkingLevel };
	}
	return { modelPattern, invalidThinking: suffix };
}

function ambiguous(pattern: string, models: readonly ChatModelRef[]): string {
	return [`"${pattern}" matches more than one model. Send one of:`, ...listRefs(models)].join("\n");
}

function unknownModel(pattern: string, models: readonly ChatModelRef[]): string {
	const closest = suggestions(pattern, models);
	if (closest.length === 0) return `No model matches "${pattern}".\nSend /model to list authenticated models.`;
	return [`No model matches "${pattern}".`, "Closest:", ...closest.map((model) => `- ${modelRef(model)}`)].join("\n");
}

function listRefs(models: readonly ChatModelRef[]): string[] {
	return [...models]
		.sort((a, b) => modelRef(a).localeCompare(modelRef(b)))
		.slice(0, 8)
		.map((model) => `- ${modelRef(model)}`);
}

function suggestions(pattern: string, models: readonly ChatModelRef[]): ChatModelRef[] {
	const needle = pattern.toLowerCase();
	return [...models]
		.map((model) => ({ model, score: suggestionScore(needle, model) }))
		.filter((item) => item.score <= 8)
		.sort((a, b) => a.score - b.score || modelRef(a.model).localeCompare(modelRef(b.model)))
		.slice(0, 5)
		.map((item) => item.model);
}

function suggestionScore(needle: string, model: ChatModelRef): number {
	const id = model.id.toLowerCase();
	const ref = modelRef(model).toLowerCase();
	if (id === needle || ref === needle) return 0;
	if (id.startsWith(needle) || ref.startsWith(needle) || needle.startsWith(id) || needle.startsWith(ref)) return 1;
	if (id.includes(needle) || ref.includes(needle) || needle.includes(id)) return 2;
	return Math.min(editDistance(needle, id), editDistance(needle, ref));
}

function editDistance(left: string, right: string): number {
	if (left === right) return 0;
	if (!left.length) return Math.min(right.length, 99);
	if (!right.length) return Math.min(left.length, 99);
	const prev = new Array<number>(right.length + 1);
	const next = new Array<number>(right.length + 1);
	for (let column = 0; column <= right.length; column++) prev[column] = column;
	for (let row = 1; row <= left.length; row++) {
		next[0] = row;
		for (let column = 1; column <= right.length; column++) {
			const cost = left[row - 1] === right[column - 1] ? 0 : 1;
			next[column] = Math.min(next[column - 1] + 1, prev[column] + 1, prev[column - 1] + cost);
		}
		for (let column = 0; column <= right.length; column++) prev[column] = next[column];
	}
	return prev[right.length] ?? 99;
}

function same(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}
