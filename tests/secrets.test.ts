import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearPendingSecrets, createSecretRequest, tryDecryptSecret, writeRuntimeSecret } from "../src/secrets.js";

test("runtime secrets are conversation-bound and private even if the file already exists", async () => {
	assert.throws(() => createSecretRequest("../token", "desc", "acc/room"), /simple filename/);
	assert.throws(() => createSecretRequest("token", "desc", " "), /bound to a conversation/);
	const first = createSecretRequest("token", "api token", "acc/room");
	const second = createSecretRequest("token", "api token", "other/room");
	assert.notEqual(first.requestId, second.requestId);
	assert.equal(tryDecryptSecret(`!secret:${first.requestId}:not-valid`), undefined);
	assert.equal(tryDecryptSecret("no secret here"), undefined);
	clearPendingSecrets("acc/room");
	assert.equal(tryDecryptSecret(`!secret:${first.requestId}:aaaa`), undefined);
	clearPendingSecrets();

	const root = await mkdtemp(join(tmpdir(), "pi-chat-secret-"));
	try {
		const target = await writeRuntimeSecret(root, "token", "plaintext");
		await chmod(target, 0o644);
		await writeRuntimeSecret(root, "token", "plaintext");
		assert.equal((await stat(target)).mode & 0o777, 0o600);
		assert.equal((await stat(join(root, ".secrets"))).mode & 0o777, 0o700);
		await assert.rejects(writeRuntimeSecret(root, "../token", "x"), /simple filename/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
