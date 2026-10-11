import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { GondolinSecretConfig } from "./core/config-types.js";
import { canonicalHost, type DockerSettings } from "./docker-config.js";

const PREFIX = "PI_CHAT_SECRET_";
export function publicAddress(address: string): boolean {
	try {
		const parsed = ipaddr.process(address);
		return parsed.range() === "unicast";
	} catch {
		return false;
	}
}
export async function guardedAddress(
	host: string,
	resolver: (
		host: string,
		options: { all: true; verbatim: true },
	) => Promise<Array<{ address: string; family: number }>> = lookup,
): Promise<{ address: string; family: number }> {
	const addresses = await resolver(host, { all: true, verbatim: true });
	if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error("egress: denied address");
	return addresses[0];
}
export class DockerPolicy {
	readonly env: Record<string, string> = {};
	private readonly entries: Array<{ token: string; value: string; hosts: string[] }> = [];
	constructor(
		readonly network: DockerSettings["network"],
		secrets: Record<string, GondolinSecretConfig>,
	) {
		for (const [name, secret] of Object.entries(secrets)) {
			const token = `${PREFIX}${randomBytes(24).toString("hex")}`;
			this.env[name] = token;
			this.entries.push({ token, value: secret.value, hosts: secret.hosts.map(canonicalHost) });
		}
	}
	host(value: string): string {
		const host = canonicalHost(value);
		if (!this.network.allowedHosts.includes(host)) throw new Error("egress: denied host");
		return host;
	}
	private substitute(value: string, host: string, secure: boolean, replace: boolean): string {
		for (const entry of this.entries) {
			const token = value.includes(entry.token);
			const real = value.includes(entry.value);
			if ((token || real) && (!secure || !entry.hosts.includes(host)))
				throw new Error("egress: denied secret destination");
			if (token && replace) value = value.split(entry.token).join(entry.value);
		}
		let unknown = value;
		if (!replace) for (const entry of this.entries) unknown = unknown.split(entry.token).join("");
		if (unknown.includes(PREFIX)) throw new Error("egress: unknown, expired or unsupported placeholder");
		return value;
	}
	rewrite(url: URL, headers: Record<string, string>): Record<string, string> {
		const host = this.host(url.hostname);
		const secure = url.protocol === "https:";
		if (
			(!secure && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			(url.port && url.port !== (secure ? "443" : "80"))
		)
			throw new Error("egress: denied protocol");
		if (decodeURIComponent(url.pathname).includes(PREFIX)) throw new Error("egress: placeholder in path unsupported");
		const result: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			if (name === "proxy-authorization" || name === "proxy-connection") continue;
			if (name === "authorization" && /^Basic /i.test(value)) {
				const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
				result[name] = `Basic ${Buffer.from(this.substitute(decoded, host, secure, true)).toString("base64")}`;
			} else result[name] = this.substitute(value, host, secure, true);
		}
		const params = [...url.searchParams].map(([key, value]) => [
			this.substitute(key, host, secure, this.network.replaceSecretsInQuery),
			this.substitute(value, host, secure, this.network.replaceSecretsInQuery),
		]);
		if (this.network.replaceSecretsInQuery) {
			url.search = "";
			for (const [key, value] of params) url.searchParams.append(key, value);
		}
		return result;
	}
}
