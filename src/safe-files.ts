import { spawn } from "node:child_process";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../assets/docker/files.py", import.meta.url));
export const FILE_LIMIT = 50 * 1024 * 1024;
/** Linux host bridge. Python's dir_fd operations avoid pathname check/open races. */
export function safeFile(op: string, root: string, path: string, input?: Buffer): Promise<Buffer> {
	const rel = relative(root, path);
	if (
		rel === ".." ||
		rel.startsWith("../") ||
		rel.startsWith("/") ||
		rel.includes("\0") ||
		(input?.length ?? 0) > FILE_LIMIT
	)
		return Promise.reject(new Error("Host file bridge rejected path or size"));
	return new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/python3", ["-I", helper, op, root, rel], {
			env: { PATH: "/usr/bin:/bin" },
			stdio: ["pipe", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > FILE_LIMIT) child.kill("SIGKILL");
			else chunks.push(chunk);
		});
		child.stdin.on("error", () => undefined);
		child.on("error", () => {
			clearTimeout(timer);
			reject(new Error("Host file bridge unavailable (requires Linux Python 3)"));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 || size > FILE_LIMIT) reject(new Error("Host file bridge rejected operation"));
			else resolve(Buffer.concat(chunks));
		});
		child.stdin.end(input);
	});
}
