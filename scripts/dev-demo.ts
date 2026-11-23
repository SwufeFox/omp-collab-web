/**
 * One-command local demo runner: starts the Bun HTML dev server and the
 * scripted mock collab host together, then prints a clickable deep link.
 */
import * as path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");

const webProc = Bun.spawn([process.execPath, "./index.html", "--host=127.0.0.1", "--port=3000"], {
	cwd: rootDir,
	stdout: "inherit",
	stderr: "inherit",
});

const hostProc = Bun.spawn([process.execPath, "scripts/mock-host.ts"], {
	cwd: rootDir,
	stdout: "pipe",
	stderr: "inherit",
});

let stopping = false;
function shutdown(): void {
	if (stopping) return;
	stopping = true;
	try {
		hostProc.kill("SIGTERM");
	} catch {}
	try {
		webProc.kill("SIGTERM");
	} catch {}
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const reader = hostProc.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";
let printedBanner = false;

async function pumpHostStdout(): Promise<void> {
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		process.stdout.write(chunk);
		if (!printedBanner) {
			buffer += chunk;
			const match = /ws:\/\/localhost:\d+\/r\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(buffer);
			if (match) {
				printedBanner = true;
				const link = match[0];
				console.log("");
				console.log(`  Open directly in browser: http://localhost:3000/#${link}`);
				console.log("");
			}
		}
	}
}

await Promise.all([
	pumpHostStdout(),
	Promise.race([webProc.exited, hostProc.exited]).then(code => {
		shutdown();
		process.exit(code);
	}),
]);
