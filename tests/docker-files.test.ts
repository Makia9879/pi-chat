import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { dockerPath } from "../src/docker.js";
import { safeFile } from "../src/safe-files.js";
import { writeRuntimeSecret } from "../src/secrets.js";

test("fd-relative helper preserves bytes/mode and supports real pi read/write/edit", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-files-"));
	try {
		const file = join(root, "quotes'\n-name.txt");
		const operations = {
			readFile: (p: string) => safeFile("read", root, p),
			access: async (p: string) => {
				await safeFile("access", root, p);
			},
			writeFile: async (p: string, text: string) => {
				await safeFile("write", root, p, Buffer.from(text));
			},
			mkdir: async (p: string) => {
				await safeFile("mkdir", root, p);
			},
		};
		await createWriteTool(root, { operations }).execute("1", { path: file, content: "hello world\n你好\n" });
		await createEditTool(root, { operations }).execute("2", {
			path: file,
			edits: [{ oldText: "hello world", newText: "goodbye" }],
		});
		assert.match(JSON.stringify(await createReadTool(root, { operations }).execute("3", { path: file })), /goodbye/);
		const binary = Buffer.from([0, 1, 255, 128]);
		await safeFile("write", root, join(root, "binary"), binary);
		assert.deepEqual(await safeFile("read", root, join(root, "binary")), binary);
		await writeRuntimeSecret(root, "token", "private");
		assert.equal((await stat(join(root, ".secrets", "token"))).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("file paths, parent/final links, hardlinks and secret-directory replacement fail closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-links-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-chat-sentinel-"));
	try {
		await writeFile(join(outside, "secret"), "sentinel");
		await symlink(outside, join(root, "parent"));
		await symlink(join(outside, "secret"), join(root, "final"));
		await symlink(join(outside, "absent"), join(root, "dangling"));
		await link(join(outside, "secret"), join(root, "hard"));
		for (const p of ["parent/secret", "final", "dangling", "hard"]) {
			await assert.rejects(safeFile("read", root, join(root, p)));
			await assert.rejects(safeFile("write", root, join(root, p), Buffer.from("bad")));
		}
		await symlink(outside, join(root, ".secrets"));
		await assert.rejects(writeRuntimeSecret(root, "secret", "bad"));
		assert.equal(await readFile(join(outside, "secret"), "utf8"), "sentinel");
		await assert.rejects(safeFile("read", root, join(root, "../secret")));
		for (const path of ["/workspace-other/a", "/etc/passwd", "../../etc/passwd", "", "x\0x"])
			assert.throws(() => dockerPath(path));
		assert.throws(() => dockerPath("/shared/a", true));
		assert.equal(dockerPath("file").path, "/workspace/file");
		await mkdir(join(root, "directory"));
		await assert.rejects(safeFile("read", root, join(root, "directory")));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
