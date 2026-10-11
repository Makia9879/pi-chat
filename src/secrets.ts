import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { join } from "node:path";
import { safeFile } from "./safe-files.js";

const SECRET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface PendingSecretRequest {
	name: string;
	privateKeyPem: string;
	conversationId: string;
}

const pendingSecrets = new Map<string, PendingSecretRequest>();

export function createSecretRequest(
	name: string,
	description: string,
	conversationId: string,
): { requestId: string; widgetUrl: string } {
	if (!SECRET_NAME.test(name)) throw new Error("Secret name must be a simple filename");
	if (!conversationId.trim()) throw new Error("Secret request must be bound to a conversation");
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	pendingSecrets.set(requestId, { name, privateKeyPem: privateKey as string, conversationId });
	const pubB64 = (publicKey as Buffer).toString("base64");
	const hash = Buffer.from(JSON.stringify({ n: name, d: description, k: pubB64, r: requestId })).toString("base64");
	return { requestId, widgetUrl: `https://pi.dev/secret#${hash}` };
}

export function clearPendingSecrets(conversationId?: string): void {
	if (!conversationId) {
		pendingSecrets.clear();
		return;
	}
	for (const [id, pending] of pendingSecrets) {
		if (pending.conversationId === conversationId) pendingSecrets.delete(id);
	}
}

/** Plaintext runtime secret. Directory 0700 and file 0600, including when the file already existed. */
export async function writeRuntimeSecret(workspaceDir: string, name: string, content: string): Promise<string> {
	if (!SECRET_NAME.test(name)) throw new Error("Secret name must be a simple filename");
	const dir = join(workspaceDir, ".secrets");
	await safeFile("mkdir", workspaceDir, dir);
	const target = join(dir, name);
	await safeFile("secret", workspaceDir, target, Buffer.from(content));
	return target;
}

export function tryDecryptSecret(
	text: string,
): { requestId: string; name: string; decrypted: string; conversationId: string } | undefined {
	const match = text.match(/!secret:([^:]+):([A-Za-z0-9+/=]+)/);
	if (!match) return undefined;
	const [, requestId, payload] = match;
	const pending = pendingSecrets.get(requestId);
	if (!pending) return undefined;
	try {
		const buf = Buffer.from(payload, "base64");
		const kl = buf.readUInt16BE(0);
		const ek = buf.subarray(2, 2 + kl);
		const r = buf.subarray(2 + kl);
		const iv = r.subarray(0, 12);
		const tag = r.subarray(r.length - 16);
		const ct = r.subarray(12, r.length - 16);
		const aes = privateDecrypt(
			{ key: pending.privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
			ek,
		);
		const d = createDecipheriv("aes-256-gcm", aes, iv);
		d.setAuthTag(tag);
		const decrypted = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
		pendingSecrets.delete(requestId);
		return { requestId, name: pending.name, decrypted, conversationId: pending.conversationId };
	} catch {
		return undefined;
	}
}
