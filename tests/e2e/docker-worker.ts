// Disposable controller used only by the opt-in orphan-reconciliation E2E.
import { readFile } from "node:fs/promises";
import { type DockerContext, DockerExecution } from "../../src/docker.js";

const context = JSON.parse(await readFile(process.argv[2], "utf8")) as DockerContext;
const backend = new DockerExecution(context);
await backend.start();
await (await backend.createBashOperations()).exec(
	"setsid bash -c 'while :; do echo old >> orphan-ticks; sleep 0.05; done' >/dev/null 2>&1 &",
	"/workspace",
	{ onData() {} },
);
console.log("TEST_WORKER_READY");
setInterval(() => {}, 1000);
