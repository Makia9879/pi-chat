import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { GondolinSecretConfig } from "./core/config-types.js";

export interface DockerSettings {
	image: string;
	pullPolicy: "never" | "if-missing";
	runtime: string;
	user: string;
	memoryMiB: number;
	cpus: number;
	pidsLimit: number;
	tmpfsMiB: number;
	sharedReadOnly: boolean;
	network: { mode: "none" | "proxy"; allowedHosts: string[]; replaceSecretsInQuery: boolean };
	lifecycle: { onClose: "remove" | "stop"; idleTimeoutSeconds: number; retainedTtlSeconds: number };
}
export type DockerConfig = Partial<Omit<DockerSettings, "network" | "lifecycle">> & {
	network?: Partial<DockerSettings["network"]>;
	lifecycle?: Partial<DockerSettings["lifecycle"]>;
};

export function canonicalHost(value: string): string {
	if (typeof value !== "string" || /[\s/@:*?#\\%]/.test(value))
		throw new Error("Docker policy: exact DNS hostname required");
	const host = domainToASCII(value.replace(/\.$/, "")).toLowerCase();
	if (
		!host ||
		host.length > 253 ||
		isIP(host) ||
		!host.includes(".") ||
		/^\d+(\.\d+)*$/.test(host) ||
		!/[a-z]/.test(host.split(".").at(-1) ?? "") ||
		host.split(".").some((s) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))
	)
		throw new Error("Docker policy: exact DNS hostname required");
	return host;
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (const key of Object.keys(value))
		if (!keys.includes(key)) throw new Error(`${label}: unsupported setting ${key}`);
	return value as Record<string, unknown>;
}
export function validateDockerConfig(value: unknown): void {
	const v = object(
		value,
		[
			"image",
			"pullPolicy",
			"runtime",
			"user",
			"memoryMiB",
			"cpus",
			"pidsLimit",
			"tmpfsMiB",
			"sharedReadOnly",
			"network",
			"lifecycle",
		],
		"runtime.docker",
	);
	for (const [key, x] of Object.entries(v)) {
		if (key === "network") {
			const n = object(x, ["mode", "allowedHosts", "replaceSecretsInQuery"], "docker.network");
			if (n.mode !== undefined && n.mode !== "none" && n.mode !== "proxy")
				throw new Error("docker.network.mode invalid");
			if (n.replaceSecretsInQuery !== undefined && typeof n.replaceSecretsInQuery !== "boolean")
				throw new Error("replaceSecretsInQuery must be boolean");
			if (n.allowedHosts !== undefined) {
				if (!Array.isArray(n.allowedHosts)) throw new Error("allowedHosts must be an array");
				for (const h of n.allowedHosts) canonicalHost(h);
			}
		} else if (key === "lifecycle") {
			const l = object(x, ["onClose", "idleTimeoutSeconds", "retainedTtlSeconds"], "docker.lifecycle");
			if (l.onClose !== undefined && l.onClose !== "remove" && l.onClose !== "stop") throw new Error("onClose invalid");
			for (const k of ["idleTimeoutSeconds", "retainedTtlSeconds"])
				if (
					l[k] !== undefined &&
					(!Number.isInteger(l[k]) || Number(l[k]) < (k === "idleTimeoutSeconds" ? 0 : 1) || Number(l[k]) > 604800)
				)
					throw new Error(`${k} out of range`);
		} else if (["memoryMiB", "cpus", "pidsLimit", "tmpfsMiB"].includes(key)) {
			const ceiling = key === "cpus" ? 32 : key === "pidsLimit" ? 4096 : 16384;
			if (
				typeof x !== "number" ||
				!Number.isFinite(x) ||
				x <= 0 ||
				x > ceiling ||
				(key !== "cpus" && !Number.isInteger(x))
			)
				throw new Error(`docker.${key} out of range`);
		} else if (key === "sharedReadOnly") {
			if (typeof x !== "boolean") throw new Error("sharedReadOnly must be boolean");
		} else if (typeof x !== "string") throw new Error(`docker.${key} must be string`);
		else if (key === "image" && !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(x))
			throw new Error("docker.image requires a trusted repository@sha256 digest");
		else if (key === "user" && !/^[1-9][0-9]*:[1-9][0-9]*$/.test(x))
			throw new Error("docker.user requires nonzero numeric UID:GID");
		else if (key === "runtime" && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(x))
			throw new Error("docker.runtime invalid");
		else if (key === "pullPolicy" && x !== "never" && x !== "if-missing") throw new Error("docker.pullPolicy invalid");
	}
}
export function resolveDockerSettings(
	layers: Array<DockerConfig | undefined>,
	secrets: Record<string, GondolinSecretConfig> = {},
): DockerSettings {
	const result: DockerSettings = {
		image: "",
		pullPolicy: "never",
		runtime: "runc",
		user: `${process.geteuid?.() ?? 0}:${process.getegid?.() ?? 0}`,
		memoryMiB: 1024,
		cpus: 1,
		pidsLimit: 128,
		tmpfsMiB: 128,
		sharedReadOnly: true,
		network: { mode: "none", allowedHosts: [], replaceSecretsInQuery: false },
		lifecycle: { onClose: "remove", idleTimeoutSeconds: 900, retainedTtlSeconds: 86400 },
	};
	for (const layer of layers) {
		if (layer === undefined) continue;
		validateDockerConfig(layer);
		Object.assign(result, {
			...layer,
			network: { ...result.network, ...layer.network },
			lifecycle: { ...result.lifecycle, ...layer.lifecycle },
		});
	}
	validateDockerConfig(result);
	if (result.tmpfsMiB + 32 >= result.memoryMiB) throw new Error("Docker tmpfs budget must be below memory budget");
	result.network.allowedHosts = [...new Set(result.network.allowedHosts.map(canonicalHost))];
	for (const [name, secret] of Object.entries(secrets)) {
		if (result.network.mode !== "proxy") throw new Error("Docker HTTP secrets require network.mode=proxy");
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
			/^(PATH|HOME|LANG|TMPDIR|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|IFS|LD_.*|DYLD_.*|PYTHON.*|NODE_.*|.*PROXY|.*CA.*|SSL_.*)$/i.test(
				name,
			)
		)
			throw new Error("Docker secret environment name is reserved or invalid");
		if (
			typeof secret.value !== "string" ||
			!secret.value ||
			secret.value.length > 16384 ||
			/[\r\n\0]/.test(secret.value) ||
			!Array.isArray(secret.hosts) ||
			!secret.hosts.length
		)
			throw new Error("Docker secret definition invalid");
		for (const host of secret.hosts)
			if (!result.network.allowedHosts.includes(canonicalHost(host)))
				throw new Error("Docker secret host must be explicitly allowed (no wildcards)");
	}
	return result;
}

export function validateRuntimeConfig(value: unknown): void {
	if (value === undefined) return;
	const v = object(value, ["mode", "workspaceDir", "docker"], "runtime");
	if (v.mode !== undefined && !["local", "gondolin", "docker"].includes(String(v.mode)))
		throw new Error("Unknown runtime mode");
	if (
		v.workspaceDir !== undefined &&
		(typeof v.workspaceDir !== "string" || !v.workspaceDir.startsWith("/") || v.workspaceDir.includes("\0"))
	)
		throw new Error("runtime.workspaceDir must be an absolute host path");
	if (v.docker !== undefined) validateDockerConfig(v.docker);
}
