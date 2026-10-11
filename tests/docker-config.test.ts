import assert from "node:assert/strict";
import test from "node:test";
import { resolveConversation } from "../src/config.js";
import {
	canonicalHost,
	resolveDockerSettings,
	validateDockerConfig,
	validateRuntimeConfig,
} from "../src/docker-config.js";
import { config } from "./helpers.js";

export const IMAGE = `example.invalid/pi-chat@sha256:${"a".repeat(64)}`;
test("Docker configuration defaults, nested inheritance and legacy default", () => {
	assert.equal(resolveConversation(config(), "test/room")?.runtimeMode, "gondolin");
	const c = config();
	c.runtime = { docker: { image: IMAGE, network: { allowedHosts: ["API.EXAMPLE.COM."] } } };
	c.accounts.test.runtime = { docker: { cpus: 2, sharedReadOnly: false } };
	c.accounts.test.channels.room.runtime = {
		mode: "docker",
		docker: { network: { allowedHosts: [] }, lifecycle: { idleTimeoutSeconds: 0 } },
	};
	const resolved = resolveConversation(c, "test/room");
	assert.equal(resolved?.workspacePath, "/workspace");
	assert.equal(resolved?.docker?.cpus, 2);
	assert.equal(resolved?.docker?.sharedReadOnly, false);
	assert.equal(resolved?.docker?.lifecycle.idleTimeoutSeconds, 0);
	assert.deepEqual(resolved?.docker?.network.allowedHosts, []);
	assert.ok(resolved?.dockerDir?.endsWith("/docker"));
});
for (const value of [
	null,
	[],
	{ image: "alpine:latest" },
	{ user: "0:1" },
	{ user: "1:0" },
	{ memoryMiB: 0 },
	{ cpus: Infinity },
	{ pidsLimit: 1.5 },
	{ extraArgs: [] },
	{ network: null },
	{ network: { allowedHosts: null } },
	{ lifecycle: { idleTimeoutSeconds: -1 } },
	{ sharedReadOnly: null },
]) {
	test(`Docker rejects invalid configuration ${JSON.stringify(value)}`, () =>
		assert.throws(() => validateDockerConfig(value)));
}
for (const host of [
	"*",
	"*.example.com",
	"https://example.com",
	"example.com:443",
	"127.0.0.1",
	"[::1]",
	"2130706433",
	"0x7f000001",
	"x@a.com",
	"a/b.com",
	"bad..com",
	"a.com\n",
]) {
	test(`Docker rejects host ${JSON.stringify(host)}`, () => assert.throws(() => canonicalHost(host)));
}
test("Docker canonical DNS and secret policies", () => {
	assert.equal(canonicalHost("API.Example.COM."), "api.example.com");
	assert.equal(canonicalHost("bücher.example"), "xn--bcher-kva.example");
	const secrets = { TOKEN: { value: "sentinel", hosts: ["api.example.com"] } };
	assert.throws(() => resolveDockerSettings([{ image: IMAGE }], secrets), /proxy/);
	assert.throws(() => resolveDockerSettings([{ image: IMAGE, network: { mode: "proxy" } }], secrets), /explicitly/);
	assert.throws(
		() =>
			resolveDockerSettings([{ image: IMAGE, network: { mode: "proxy", allowedHosts: ["api.example.com"] } }], {
				PATH: secrets.TOKEN,
			}),
		/reserved/,
	);
	assert.equal(
		resolveDockerSettings([{ image: IMAGE, network: { mode: "proxy", allowedHosts: ["api.example.com"] } }], secrets)
			.network.mode,
		"proxy",
	);
	assert.throws(() => resolveDockerSettings([{ image: IMAGE, memoryMiB: 64 }]), /budget/);
	assert.throws(() => validateRuntimeConfig({ mode: null }));
	assert.throws(() => validateRuntimeConfig({ docker: null }));
});
