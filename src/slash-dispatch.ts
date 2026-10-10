import { CHAT_THINKING_LEVELS, type ChatThinkingLevel } from "./model-command.js";
import {
	authorizeSlash,
	choiceButtons,
	formatChangelogExcerpt,
	formatHelp,
	formatNumberedChoices,
	HOTKEY_HELP,
	type ListedCommand,
	parseSelectionReply,
	parseSlashText,
	stripCommandMentions,
} from "./slash-commands.js";

export interface SlashChoice {
	kind: "resume" | "fork" | "tree" | "confirm";
	ids: string[];
	action?: string;
}

export interface SlashDispatchInput {
	text: string;
	userId: string;
	allowedUserIds?: string[];
	botUserId?: string;
	botNames?: Array<string | undefined>;
	pending?: SlashChoice;
	commands?: readonly ListedCommand[];
	skills?: readonly ListedCommand[];
}

export interface SlashEffects {
	reply(text: string): Promise<void>;
	choose(title: string, markdown: string, buttons: Array<{ label: string; value: string }>): Promise<void>;
	attach(path: string, caption: string): Promise<void>;
	describeModel(pattern?: string): Promise<string>;
	thinkingLevel(): string;
	setThinkingLevel(level: ChatThinkingLevel): void;
	compact(instructions?: string): void;
	statusText(): string;
	sessionName(): string | undefined;
	setSessionName(name: string): void;
	sessionOp(action: string, id?: string): Promise<string>;
	expandPrompt(text: string): Promise<void>;
	listSessions(): Promise<Array<{ label: string; path: string }>>;
	listForks(): Array<{ label: string; id: string }>;
	listTree(): Array<{ label: string; id: string }>;
	exportPath(): Promise<string | undefined>;
	changelog(): string;
	saveChoice(choice: SlashChoice): void;
	clearChoice(): void;
}

export async function dispatchSlash(input: SlashDispatchInput, effects: SlashEffects): Promise<boolean> {
	const text = stripCommandMentions(input.text, { botUserId: input.botUserId, names: input.botNames });
	const selected = parseSelectionReply(text);
	if (selected && input.pending) {
		await applyChoice(selected, input, effects);
		return true;
	}
	const command = parseSlashText(text);
	if (!command) return false;
	const access = authorizeSlash(command, input.userId, input.allowedUserIds);
	if (!access.ok) {
		await effects.reply(access.text);
		return true;
	}
	await runCommand(command.name, command.args, command.kind, input, effects);
	return true;
}

async function applyChoice(index: number, input: SlashDispatchInput, effects: SlashEffects): Promise<void> {
	const pending = input.pending;
	if (!pending) return;
	const id = pending.ids[index - 1];
	effects.clearChoice();
	if (!id) {
		await effects.reply(`没有编号 ${index}。请重新发送命令。`);
		return;
	}
	if (pending.kind === "confirm") {
		if (id !== "yes") {
			await effects.reply("已取消。");
			return;
		}
		await effects.reply(await effects.sessionOp(pending.action ?? "clone"));
		return;
	}
	await effects.reply(await effects.sessionOp(pending.kind, id));
}

async function runCommand(
	name: string,
	args: string,
	kind: string,
	input: SlashDispatchInput,
	effects: SlashEffects,
): Promise<void> {
	if (name === "help") {
		await effects.reply(formatHelp(input.commands ?? [], input.skills ?? []));
		return;
	}
	if (name === "status" || name === "session") {
		const session = effects.sessionName();
		await effects.reply(
			[effects.statusText(), session ? `Session name: ${session}` : "Session name: (unset)"].join("\n"),
		);
		return;
	}
	if (name === "changelog") {
		await effects.reply(effects.changelog());
		return;
	}
	if (name === "hotkeys") {
		await effects.reply(HOTKEY_HELP);
		return;
	}
	if (name === "model") {
		await effects.reply(await effects.describeModel(args || undefined));
		return;
	}
	if (name === "thinking") {
		if (!args) {
			await effects.reply(`Thinking: ${effects.thinkingLevel()}\nLevels: ${CHAT_THINKING_LEVELS.join(", ")}`);
			return;
		}
		const level = args.split(/\s+/)[0]?.toLowerCase();
		if (!level || !CHAT_THINKING_LEVELS.includes(level as ChatThinkingLevel)) {
			await effects.reply(`未知 thinking level "${args}"。可用：${CHAT_THINKING_LEVELS.join(", ")}。`);
			return;
		}
		effects.setThinkingLevel(level as ChatThinkingLevel);
		await effects.reply(`Thinking: ${effects.thinkingLevel()}`);
		return;
	}
	if (name === "compact") {
		effects.compact(args || undefined);
		await effects.reply(args ? `已开始压缩上下文：${args}` : "已开始压缩上下文。");
		return;
	}
	if (name === "name") {
		if (!args) {
			await effects.reply(`Session name: ${effects.sessionName() || "(unset)"}`);
			return;
		}
		effects.setSessionName(args);
		await effects.reply(`Session name: ${args}`);
		return;
	}
	if (name === "new" || name === "stop") {
		await effects.reply(await effects.sessionOp(name));
		return;
	}
	if (name === "clone" || name === "reload") {
		effects.saveChoice({ kind: "confirm", action: name, ids: ["yes", "no"] });
		const markdown = formatNumberedChoices(name === "clone" ? "克隆当前会话？" : "重载 pi 扩展？", ["确认", "取消"]);
		await effects.choose(name, markdown, choiceButtons(["确认", "取消"]));
		return;
	}
	if (name === "export") {
		const path = await effects.exportPath();
		if (!path) {
			await effects.reply("当前会话没有可导出的文件。");
			return;
		}
		await effects.attach(path, "会话已导出为 JSONL。HTML 导出不在扩展 API 中。");
		return;
	}
	if (name === "resume") {
		const items = await effects.listSessions();
		if (items.length === 0) {
			await effects.reply("没有可恢复的会话。");
			return;
		}
		effects.saveChoice({ kind: "resume", ids: items.map((item) => item.path) });
		await effects.choose(
			"resume",
			formatNumberedChoices(
				"resume",
				items.map((item) => item.label),
			),
			choiceButtons(items.map((item) => item.label)),
		);
		return;
	}
	if (name === "fork" || name === "tree") {
		const items = name === "fork" ? effects.listForks() : effects.listTree();
		if (items.length === 0) {
			await effects.reply("没有可选项。");
			return;
		}
		effects.saveChoice({ kind: name, ids: items.map((item) => item.id) });
		await effects.choose(
			name,
			formatNumberedChoices(
				name,
				items.map((item) => item.label),
			),
			choiceButtons(items.map((item) => item.label)),
		);
		return;
	}
	if (kind === "skill" || name === "skill") {
		const skill = args.split(/\s+/)[0];
		if (!skill) {
			await effects.reply("用法：/skill:<名字> [参数]");
			return;
		}
		await effects.expandPrompt(`/skill:${args}`);
		await effects.reply(`已展开并发送 /skill:${skill}`);
		return;
	}
	if (kind === "extension") {
		const known = (input.commands ?? []).find((command) => command.name === name && command.source === "extension");
		if (!known) {
			const template = (input.commands ?? []).find(
				(command) => command.name === name && (command.source === "prompt" || command.source === "skill"),
			);
			if (!template) {
				await effects.reply(`${formatHelp(input.commands ?? [], input.skills ?? [])}\n\n未知命令 /${name}。`);
				return;
			}
		}
		await effects.expandPrompt(args ? `/${name} ${args}` : `/${name}`);
		await effects.reply(
			`已在 pi 会话执行 /${name}${args ? ` ${args}` : ""}。扩展若只调用终端通知，聊天里可能看不到细节。`,
		);
		return;
	}
	await effects.reply(formatHelp(input.commands ?? [], input.skills ?? []));
}

export { formatChangelogExcerpt };
