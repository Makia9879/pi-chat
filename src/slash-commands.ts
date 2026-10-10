export const READONLY_SLASH = new Set(["help", "session", "changelog", "hotkeys", "status"]);

export const FORBIDDEN_SLASH: Record<string, string> = {
	login: "不能从聊天执行 /login：它会把凭据写进运行 pi 的宿主机，也无法完成 OAuth。请在 worker 终端执行。",
	logout: "不能从聊天执行 /logout：它会删除宿主机上的 provider 凭据。请在 worker 终端执行。",
	quit: "不能从聊天执行 /quit：它会退出整个 pi 进程并拆掉聊天 worker。请用终端退出，或由管理员断开连接。",
	settings: "不能从聊天执行 /settings：它打开的是 TUI 设置菜单，扩展 API 没有可写的设置界面。",
	"scoped-models": "不能从聊天执行 /scoped-models：它依赖 TUI 多选来改会话模型范围。请在终端执行。",
	trust: "不能从聊天执行 /trust：它会把项目信任写进宿主机配置。请在终端执行。",
	share: "不能从聊天执行 /share：它会把会话上传成 GitHub gist，可能泄露对话。",
	copy: "不能从聊天执行 /copy：它依赖本机剪贴板。需要的内容已经在聊天回复里。",
	import: "不能从聊天执行 /import：它会按宿主机路径导入会话，存在任意文件读取风险。请在终端执行。",
	bug: "不能从聊天执行 /bug：它会向 pi 开发者上传诊断信息。请在终端执行。",
	llama: "不能从聊天执行 /llama：它管理本机 llama.cpp 进程，不是聊天命令。请在终端执行。",
};

/** pi-chat host management commands. Not forwarded from chat. */
export const BLOCKED_CHAT_ADMIN = new Set([
	"chat-config",
	"chat-list",
	"chat-spawn-all",
	"chat-workers",
	"chat-open-all",
	"chat-kill-all",
	"chat-connect",
	"chat-disconnect",
	"chat-new",
	"chat-status",
	"chat-op",
]);

const HANDLED = new Set([
	"help",
	"model",
	"thinking",
	"compact",
	"new",
	"session",
	"name",
	"changelog",
	"hotkeys",
	"status",
	"stop",
	"resume",
	"fork",
	"tree",
	"clone",
	"export",
	"reload",
]);

export interface ParsedSlash {
	name: string;
	args: string;
	raw: string;
	mutating: boolean;
	kind: "handled" | "skill" | "forbidden" | "extension" | "blocked-admin" | "unknown";
}

export interface ListedCommand {
	name: string;
	description?: string;
	source?: string;
}

export function stripCommandMentions(
	text: string,
	mentions: { botUserId?: string; names?: Array<string | undefined> },
): string {
	let next = text;
	if (mentions.botUserId) {
		const id = mentions.botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		next = next.replace(new RegExp(`<@!?${id}>`, "g"), " ");
	}
	for (const name of mentions.names ?? []) {
		if (!name) continue;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		next = next.replace(new RegExp(`@${escaped}\\b`, "ig"), " ");
	}
	return next.replace(/\s+/g, " ").trim();
}

export function parseSlashText(text: string): ParsedSlash | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(/^\/?([A-Za-z][\w-]*)(?::([^\s]+))?(?:\s+([\s\S]+))?$/);
	if (!match) return undefined;
	const bare = !trimmed.startsWith("/");
	const name = (match[1] ?? "").toLowerCase();
	const skillName = match[2];
	const args = (match[3] ?? "").trim();
	if (bare && !HANDLED.has(name) && !FORBIDDEN_SLASH[name]) return undefined;
	if (name === "skill" && skillName) {
		return {
			name: "skill",
			args: args ? `${skillName} ${args}` : skillName,
			raw: trimmed,
			mutating: true,
			kind: "skill",
		};
	}
	if (FORBIDDEN_SLASH[name]) {
		return { name, args, raw: trimmed, mutating: false, kind: "forbidden" };
	}
	if (HANDLED.has(name)) {
		return { name, args, raw: trimmed, mutating: !READONLY_SLASH.has(name), kind: "handled" };
	}
	if (BLOCKED_CHAT_ADMIN.has(name) || name.startsWith("chat-")) {
		return { name, args, raw: trimmed, mutating: true, kind: "blocked-admin" };
	}
	if (bare) return undefined;
	return { name, args, raw: trimmed, mutating: true, kind: "extension" };
}

export function authorizeSlash(
	command: Pick<ParsedSlash, "name" | "mutating" | "kind">,
	userId: string,
	allowedUserIds: string[] | undefined,
): { ok: true } | { ok: false; text: string } {
	if (command.kind === "forbidden")
		return { ok: false, text: FORBIDDEN_SLASH[command.name] ?? "此命令不能从聊天执行。" };
	if (command.kind === "blocked-admin") {
		return { ok: false, text: `/${command.name} 是 pi-chat 的宿主机管理命令，不能从聊天执行。` };
	}
	const allow = (allowedUserIds ?? []).map((id) => id.trim()).filter(Boolean);
	if (allow.length > 0) {
		if (!allow.includes(userId)) return { ok: false, text: "只有 access.allowedUserIds 中的用户可以执行聊天命令。" };
		return { ok: true };
	}
	if (!command.mutating || READONLY_SLASH.has(command.name)) return { ok: true };
	return {
		ok: false,
		text: "当前频道没有设置 allowedUserIds。未配置白名单时只允许只读命令：/help /session /changelog /hotkeys /status。",
	};
}

export function parseSelectionReply(text: string): number | undefined {
	const match = text.trim().match(/^(?:\/pi-select\s+)?(\d{1,3})$/);
	if (!match?.[1]) return undefined;
	const value = Number(match[1]);
	return value >= 1 && value <= 100 ? value : undefined;
}

export function formatHelp(commands: readonly ListedCommand[], skills: readonly ListedCommand[] = []): string {
	const extensions = commands.filter(
		(command) =>
			command.source === "extension" && !BLOCKED_CHAT_ADMIN.has(command.name) && !command.name.startsWith("chat-"),
	);
	const prompts = commands.filter((command) => command.source === "prompt" || command.source === "skill");
	const lines = [
		"**聊天命令**",
		"`/help` — 本帮助",
		"`/status` `/session` — 连接、模型、用量和花费",
		"`/changelog` — pi 更新说明摘录",
		"`/hotkeys` — 终端快捷键说明（聊天里没有实时键位表）",
		"",
		"**需要白名单的命令**",
		"`/model [pattern]` — 列出或切换已认证模型，支持 provider/id 和 :thinking",
		"`/thinking [level]` — 查看或设置 thinking level",
		"`/compact [说明]` — 压缩上下文",
		"`/new` — 新会话并保持聊天连接",
		"`/name [名字]` — 查看或设置会话名",
		"`/stop` — 中止当前 turn",
		"`/resume` `/fork` `/tree` — 编号选择会话、分叉点或树节点",
		"`/clone` `/reload` — 确认后克隆会话或重载扩展",
		"`/export` — 把当前会话 JSONL 作为附件发回",
		"`/skill:<名字> [参数]` — 展开 skill 后作为 prompt 发送",
		"",
		"**不会从聊天执行**",
		Object.keys(FORBIDDEN_SLASH)
			.map((name) => `/${name}`)
			.join(" "),
		"以及 pi-chat 管理命令 /chat-config /chat-kill-all /chat-spawn-all /chat-disconnect 等。",
	];
	if (skills.length > 0) {
		lines.push("", "**Skills**");
		for (const skill of skills) lines.push(`\`/skill:${skill.name}\` — ${skill.description || skill.name}`);
	}
	if (prompts.length > 0) {
		lines.push("", "**提示词模板 / skill 命令**");
		for (const command of prompts) lines.push(`\`/${command.name}\` — ${command.description || command.source}`);
	}
	if (extensions.length > 0) {
		lines.push("", "**已安装扩展命令**");
		for (const command of extensions) {
			const description = (command.description || "扩展命令").split("\n")[0];
			lines.push(`\`/${command.name}\` — ${description}`);
		}
	} else {
		lines.push("", "**已安装扩展命令**", "（当前没有可透传的扩展斜杠命令）");
	}
	lines.push("", "未设置 allowedUserIds 时，只能使用只读命令。");
	return lines.join("\n");
}

export function formatNumberedChoices(title: string, items: readonly string[]): string {
	const lines = [`**${title}**`, "回复编号，或点卡片按钮。", ""];
	for (const [index, item] of items.entries()) lines.push(`${index + 1}. ${item}`);
	if (items.length === 0) lines.push("（没有可选项）");
	return lines.join("\n");
}

export function formatChangelogExcerpt(markdown: string, maxLines = 40): string {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+/.test(line));
	const slice = (start >= 0 ? lines.slice(start) : lines).slice(0, maxLines);
	return ["**Changelog**", "", ...slice].join("\n").trim();
}

export const HOTKEY_HELP = [
	"**Hotkeys**",
	"聊天里没有 TUI，扩展 API 也读不到当前 keybindings.json。下面是 pi 编辑器的默认键位，只在 worker 终端有效。",
	"",
	"- 发送：enter",
	"- 换行：shift+enter 或 ctrl+enter（取决于终端）",
	"- 中止：escape / ctrl+c",
	"- 新会话：ctrl+shift+n（app.session.new）",
	"- 会话树：ctrl+shift+t（app.session.tree）",
	"- 行首/行尾：ctrl+a / ctrl+e",
	"- 删到行首/行尾：ctrl+u / ctrl+k",
	"",
	"改键后在终端执行 /reload。聊天里的 /reload 会重载扩展，可能断开当前连接。",
].join("\n");

export function choiceButtons(items: readonly string[], limit = 8): Array<{ label: string; value: string }> {
	return items.slice(0, limit).map((item, index) => ({
		label: `${index + 1}. ${item}`.slice(0, 40),
		value: String(index + 1),
	}));
}
