import assert from "node:assert/strict";
import test from "node:test";
import { DockerPolicy, guardedAddress, publicAddress } from "../src/docker-policy.js";

function policy(query = false) {
	return new DockerPolicy(
		{ mode: "proxy", allowedHosts: ["api.example.com", "other.example.com"], replaceSecretsInQuery: query },
		{ TOKEN: { value: "REAL_SENTINEL", hosts: ["api.example.com"] } },
	);
}
test("secret substitution: Bearer, Basic, body-independent, HTTPS only, wrong host", () => {
	const p = policy();
	const url = new URL("https://api.example.com/path");
	assert.equal(p.rewrite(url, { authorization: `Bearer ${p.env.TOKEN}` }).authorization, "Bearer REAL_SENTINEL");
	const basic = Buffer.from(`user:${p.env.TOKEN}`).toString("base64");
	assert.equal(
		Buffer.from(p.rewrite(url, { authorization: `Basic ${basic}` }).authorization.slice(6), "base64").toString(),
		"user:REAL_SENTINEL",
	);
	for (const value of [p.env.TOKEN, "REAL_SENTINEL"]) {
		assert.throws(() => p.rewrite(new URL("http://api.example.com"), { authorization: value }));
		assert.throws(() => p.rewrite(new URL("https://other.example.com"), { authorization: value }));
	}
	assert.throws(() => p.rewrite(url, { authorization: policy().env.TOKEN }), /expired/);
	assert.throws(() => p.rewrite(new URL("https://denied.example.com"), {}), /denied/);
	assert.equal(p.rewrite(url, { "proxy-authorization": "secret" })["proxy-authorization"], undefined);
});
test("query off/on and raw query unchanged when off", () => {
	for (const replace of [false, true]) {
		const p = policy(replace);
		const url = new URL(`https://api.example.com?q=${p.env.TOKEN}&space=a%20b`);
		p.rewrite(url, {});
		assert.equal(url.searchParams.get("q"), replace ? "REAL_SENTINEL" : p.env.TOKEN);
		if (!replace) assert.ok(url.search.includes("a%20b"));
	}
});
test("empty list denies; private/reserved IPs including mapped rejected", async () => {
	assert.throws(() =>
		new DockerPolicy({ mode: "proxy", allowedHosts: [], replaceSecretsInQuery: false }, {}).host("api.example.com"),
	);
	for (const ip of [
		"0.0.0.0",
		"127.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"169.254.169.254",
		"192.168.1.1",
		"192.0.2.1",
		"198.18.0.1",
		"224.0.0.1",
		"240.1.1.1",
		"::1",
		"::",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"::ffff:127.0.0.1",
	])
		assert.equal(publicAddress(ip), false, ip);
	assert.equal(publicAddress("8.8.8.8"), true);
	assert.equal(publicAddress("2606:4700:4700::1111"), true);
	const resolver = async () => [
		{ address: "8.8.8.8", family: 4 },
		{ address: "127.0.0.1", family: 4 },
	];
	await assert.rejects(guardedAddress("api.example.com", resolver), /denied/);
});
