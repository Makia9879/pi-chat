import assert from "node:assert/strict";
import test from "node:test";
import { consumeCardActionToken, feishuCardSelection, feishuChoiceCard, feishuPostBody } from "../src/feishu-cards.js";
import {
	authorizeSlash,
	formatHelp,
	parseSelectionReply,
	parseSlashText,
	stripCommandMentions,
} from "../src/slash-commands.js";
import { dispatchSlash } from "../src/slash-dispatch.js";

test("slash parser accepts slashed and bare controls, skills, and blocks admin commands", () => {
	assert.equal(parseSlashText("model grok-4.7")?.name, "model");
	assert.equal(parseSlashText("/thinking high")?.args, "high");
	assert.equal(parseSlashText("/skill:review the diff")?.kind, "skill");
	assert.equal(parseSlashText("/login")?.kind, "forbidden");
	assert.equal(parseSlashText("/chat-kill-all")?.kind, "blocked-admin");
	assert.equal(parseSlashText("/chrome doctor")?.kind, "extension");
	assert.equal(parseSlashText("hello"), undefined);
	assert.equal(stripCommandMentions("<@ou_bot> /help", { botUserId: "ou_bot" }), "/help");
	assert.equal(parseSelectionReply("2"), 2);
	assert.equal(parseSelectionReply("/pi-select 3"), 3);
});

test("empty allowlist permits only readonly slash commands", () => {
	assert.equal(authorizeSlash({ name: "help", mutating: false, kind: "handled" }, "ou_user", []).ok, true);
	const denied = authorizeSlash({ name: "new", mutating: true, kind: "handled" }, "ou_user", []);
	assert.equal(denied.ok, false);
	if (!denied.ok) assert.match(denied.text, /allowedUserIds/);
	assert.equal(authorizeSlash({ name: "new", mutating: true, kind: "handled" }, "ou_ok", ["ou_ok"]).ok, true);
	assert.equal(authorizeSlash({ name: "login", mutating: false, kind: "forbidden" }, "ou_ok", ["ou_ok"]).ok, false);
});

test("help lists extension commands and omits pi-chat admin commands", () => {
	const help = formatHelp(
		[
			{ name: "chrome", description: "All pi-chrome controls", source: "extension" },
			{ name: "chat-kill-all", description: "kill workers", source: "extension" },
			{ name: "review", description: "Review prompt", source: "prompt" },
		],
		[{ name: "frontend-testing", description: "Check a page" }],
	);
	assert.match(help, /\/chrome/);
	assert.match(help, /\/skill:frontend-testing/);
	assert.match(help, /\/review/);
	assert.doesNotMatch(help, /`\/chat-kill-all` —/);
});

test("Feishu cards follow the Hermes button shape and dedup action tokens", () => {
	const card = feishuChoiceCard("resume", "1. yesterday", [{ label: "1. yesterday", value: "1" }]);
	const elements = card.elements as Array<{ tag: string; actions?: Array<{ value: { pi_chat_select: string } }> }>;
	assert.equal(elements[0]?.tag, "markdown");
	assert.equal(elements[1]?.actions?.[0]?.value.pi_chat_select, "1");
	assert.equal(feishuPostBody("hello\nworld").zh_cn.content[0]?.[0]?.tag, "md");
	const seen = new Map<string, number>();
	assert.equal(consumeCardActionToken(seen, "tok"), true);
	assert.equal(consumeCardActionToken(seen, "tok"), false);
	assert.deepEqual(
		feishuCardSelection({
			event_type: "card.action.trigger",
			operator: { open_id: "ou_user" },
			action: { value: { pi_chat_select: "2" } },
			token: "tok",
		}),
		{ userId: "ou_user", index: 2, token: "tok" },
	);
});

test("dispatchSlash replies with help and does not run a forbidden command", async () => {
	const replies: string[] = [];
	const handled = await dispatchSlash(
		{ text: "/login", userId: "ou_user", allowedUserIds: ["ou_user"], commands: [] },
		fakeEffects(replies),
	);
	assert.equal(handled, true);
	assert.match(replies[0] ?? "", /不能从聊天执行 \/login/);
	const help = await dispatchSlash({ text: "/help", userId: "ou_user", commands: [] }, fakeEffects(replies));
	assert.equal(help, true);
	assert.match(replies.at(-1) ?? "", /聊天命令/);
});

function fakeEffects(replies: string[]) {
	return {
		reply: async (text: string) => {
			replies.push(text);
		},
		choose: async (_title: string, markdown: string) => {
			replies.push(markdown);
		},
		attach: async () => {},
		describeModel: async () => "model",
		thinkingLevel: () => "low",
		setThinkingLevel: () => {},
		compact: () => {},
		statusText: () => "status",
		sessionName: () => undefined,
		setSessionName: () => {},
		sessionOp: async () => "ok",
		expandPrompt: async () => {},
		listSessions: async () => [],
		listForks: () => [],
		listTree: () => [],
		exportPath: async () => undefined,
		changelog: () => "changelog",
		saveChoice: () => {},
		clearChoice: () => {},
	};
}
