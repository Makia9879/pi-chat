import assert from "node:assert/strict";
import test from "node:test";
import { formatModelList, formatModelSwitch, resolveChatModel } from "../src/model-command.js";

const models = [
	{ provider: "openai", id: "gpt-6-luna", name: "GPT 6 Luna" },
	{ provider: "xai", id: "grok-4.7", name: "Grok 4.7" },
	{ provider: "xai", id: "grok-3", name: "Grok 3" },
	{ provider: "openrouter", id: "meta:exacto", name: "Exacto" },
];

test("model list shows the current model and only the supplied authenticated models", () => {
	const text = formatModelList({ current: models[0], thinking: "low", models });
	assert.match(text, /Current: openai\/gpt-6-luna/);
	assert.match(text, /Thinking: low/);
	assert.match(text, /- xai\/grok-4\.7/);
	assert.equal(formatModelList({ models: [], thinking: "off" }).includes("No authenticated models"), true);
});

test("model patterns match id, provider/id, and a thinking suffix", () => {
	const byId = resolveChatModel("grok-4.7", models);
	assert.equal(byId.ok && byId.model.id, "grok-4.7");
	const qualified = resolveChatModel("xai/grok-4.7:high", models);
	assert.equal(qualified.ok && qualified.model.provider, "xai");
	assert.equal(qualified.ok && qualified.thinkingLevel, "high");
	const colonId = resolveChatModel("openrouter/meta:exacto", models);
	assert.equal(colonId.ok && colonId.model.id, "meta:exacto");
	assert.equal(colonId.ok && colonId.thinkingLevel, undefined);
	assert.match(formatModelSwitch(models[1], "high", "high"), /Switched to xai\/grok-4\.7/);
	assert.match(formatModelSwitch(models[1], "medium", "high"), /clamped/);
});

test("unknown model patterns suggest nearby models and reject bad thinking levels", () => {
	const missing = resolveChatModel("grok-9", models);
	assert.equal(missing.ok, false);
	if (!missing.ok) {
		assert.match(missing.text, /No model matches "grok-9"/);
		assert.match(missing.text, /xai\/grok-4\.7/);
	}
	const ambiguous = resolveChatModel("grok", models);
	assert.equal(ambiguous.ok, false);
	if (!ambiguous.ok) assert.match(ambiguous.text, /more than one model/);
	const badLevel = resolveChatModel("grok-4.7:turbo", models);
	assert.equal(badLevel.ok, false);
	if (!badLevel.ok) assert.match(badLevel.text, /Unknown thinking level "turbo"/);
});
