import { describe, expect, it } from "bun:test";
import {
	extractBangCommand,
	filterSlashCommands,
	formatRunAgentPrompt,
	parseSlashCommand,
	shouldShowCommandMenu,
} from "../src/lib/commands";

describe("web composer slash & shell command parsing", () => {
	it("resolves host control commands and aliases", () => {
		const resume = parseSlashCommand("/resume");
		expect(resume.kind).toBe("command");
		if (resume.kind === "command") {
			expect(resume.def.id).toBe("continue");
			expect(resume.def.scope).toBe("host");
		}

		const abort = parseSlashCommand("/abort");
		expect(abort.kind).toBe("command");
		if (abort.kind === "command") expect(abort.def.id).toBe("stop");
	});

	it("extracts arguments for /steer, /queue, and /run", () => {
		const run = parseSlashCommand("  /run git status -sb  ");
		expect(run.kind).toBe("command");
		if (run.kind === "command") {
			expect(run.def.id).toBe("run");
			expect(run.arg).toBe("git status -sb");
		}

		const prompt = formatRunAgentPrompt("bun test");
		expect(prompt).toContain("```sh\nbun test\n```");
	});

	it("treats unknown slash tokens explicitly and ignores multiline text", () => {
		const unk = parseSlashCommand("/compact");
		expect(unk).toEqual({ kind: "unknown", rawName: "compact", arg: "" });

		expect(parseSlashCommand("/continue\nmore text")).toEqual({ kind: "none" });
		expect(shouldShowCommandMenu("/continue\nmore")).toBe(false);
	});

	it("filters command suggestions cleanly and detects !bang shell syntax", () => {
		expect(filterSlashCommands("/st").map(c => c.id)).toEqual(["stop", "steer", "standard"]);
		expect(shouldShowCommandMenu("/")).toBe(true);
		expect(shouldShowCommandMenu("/run ls -la")).toBe(true);
		expect(shouldShowCommandMenu("/etc/hosts check")).toBe(false);
		expect(shouldShowCommandMenu("!bun test")).toBe(true);
		expect(extractBangCommand("!! git diff")).toBe("git diff");
	});
});
