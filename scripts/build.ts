/**
 * Cross-platform static build for collab-web.
 * Cleans dist/, bundles index.html via Bun, normalizes entry HTML to dist/index.html,
 * and copies public/ assets into dist/.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const distDir = path.join(rootDir, "dist");
const publicDir = path.join(rootDir, "public");

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

const proc = Bun.spawn(
	[
		process.execPath,
		"build",
		"./index.html",
		"--outdir=dist",
		"--minify",
		"--define",
		'process.env.NODE_ENV="production"',
		"--entry-naming=[hash].[ext]",
		"--chunk-naming=[hash].[ext]",
		"--asset-naming=[hash].[ext]",
	],
	{
		cwd: rootDir,
		stdout: "inherit",
		stderr: "inherit",
	},
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
	process.exit(exitCode);
}

const entries = await fs.readdir(distDir, { withFileTypes: true });
const htmlFiles = entries.filter(e => e.isFile() && e.name.endsWith(".html")).map(e => e.name);
if (htmlFiles.length === 1 && htmlFiles[0] !== "index.html") {
	await fs.rename(path.join(distDir, htmlFiles[0]!), path.join(distDir, "index.html"));
}

try {
	const stat = await fs.stat(publicDir);
	if (stat.isDirectory()) {
		await fs.cp(publicDir, distDir, { recursive: true, force: true });
	}
} catch {
	// public/ absent — skip
}

console.log("Built static bundle in dist/");
