export type CommandScope = "host" | "agent" | "view";

export type SlashCommandId =
	| "continue"
	| "stop"
	| "deliver"
	| "steer"
	| "queue"
	| "run"
	| "agents"
	| "focus"
	| "standard"
	| "detailed"
	| "theme"
	| "copy-link"
	| "leave";

export interface SlashCommandDef {
	readonly id: SlashCommandId;
	readonly name: string;
	readonly aliases: readonly string[];
	readonly usage: string;
	readonly description: string;
	readonly takesArgs: boolean;
	readonly scope: CommandScope;
	readonly requiresBusy?: boolean;
	readonly requiresQueue?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
	{
		id: "continue",
		name: "continue",
		aliases: ["resume"],
		usage: "/continue",
		description: "Resume host session turn via protocol resume",
		takesArgs: false,
		scope: "host",
	},
	{
		id: "deliver",
		name: "deliver",
		aliases: ["flush"],
		usage: "/deliver",
		description: "Interrupt active run and deliver queued follow-ups now",
		takesArgs: false,
		scope: "host",
		requiresBusy: true,
		requiresQueue: true,
	},
	{
		id: "stop",
		name: "stop",
		aliases: ["abort"],
		usage: "/stop",
		description: "Interrupt the active host turn",
		takesArgs: false,
		scope: "host",
		requiresBusy: true,
	},
	{
		id: "steer",
		name: "steer",
		aliases: [],
		usage: "/steer <message>",
		description: "Steer the active host turn immediately",
		takesArgs: true,
		scope: "host",
	},
	{
		id: "queue",
		name: "queue",
		aliases: ["followup"],
		usage: "/queue <message>",
		description: "Queue a follow-up after the active host turn",
		takesArgs: true,
		scope: "host",
	},
	{
		id: "run",
		name: "run",
		aliases: ["bash", "exec"],
		usage: "/run <command>",
		description: "Ask the host agent to run a workspace command via bash tool",
		takesArgs: true,
		scope: "agent",
	},
	{
		id: "agents",
		name: "agents",
		aliases: ["subagents"],
		usage: "/agents",
		description: "Toggle session & subagent list drawer",
		takesArgs: false,
		scope: "view",
	},
	{
		id: "focus",
		name: "focus",
		aliases: [],
		usage: "/focus",
		description: "Fold settled tool trace groups",
		takesArgs: false,
		scope: "view",
	},
	{
		id: "standard",
		name: "standard",
		aliases: [],
		usage: "/standard",
		description: "Expand latest & error trace steps",
		takesArgs: false,
		scope: "view",
	},
	{
		id: "detailed",
		name: "detailed",
		aliases: [],
		usage: "/detailed",
		description: "Expand all trace steps and tool outputs",
		takesArgs: false,
		scope: "view",
	},
	{
		id: "theme",
		name: "theme",
		aliases: [],
		usage: "/theme",
		description: "Cycle theme (System / Light / Dark)",
		takesArgs: false,
		scope: "view",
	},
	{
		id: "copy-link",
		name: "copy-link",
		aliases: ["invite"],
		usage: "/copy-link",
		description: "Copy session invite link to clipboard",
		takesArgs: false,
		scope: "view",
	},
	{
		id: "leave",
		name: "leave",
		aliases: [],
		usage: "/leave",
		description: "Disconnect from current session",
		takesArgs: false,
		scope: "view",
	},
];

export type ParsedSlashCommand =
	| { kind: "none" }
	| { kind: "command"; def: SlashCommandDef; arg: string }
	| { kind: "unknown"; rawName: string; arg: string };

/**
 * Parses a single-line composer draft starting with `/`. Multiline drafts return
 * `{ kind: "none" }` so pasting file paths or multi-line prose starting with `/` submits normally.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/") || trimmed.includes("\n")) return { kind: "none" };
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { kind: "none" };
	const rawName = match[1]!.toLowerCase();
	const arg = (match[2] ?? "").trim();
	const def = SLASH_COMMANDS.find(c => c.name === rawName || c.aliases.includes(rawName));
	if (!def) return { kind: "unknown", rawName, arg };
	return { kind: "command", def, arg };
}

/** True when input should reveal the composer's live slash/shell helper popover. */
export function shouldShowCommandMenu(input: string): boolean {
	if (input.includes("\n")) return false;
	const trimmedStart = input.trimStart();
	if (trimmedStart.startsWith("!")) return true;
	if (!trimmedStart.startsWith("/")) return false;
	const afterSlash = trimmedStart.slice(1);
	const spaceIdx = afterSlash.indexOf(" ");
	if (spaceIdx < 0) return true;
	const cmdWord = afterSlash.slice(0, spaceIdx).toLowerCase();
	// Keep menu hidden once typing free-form prose for unrelated tokens like "/tmp/foo bar",
	// except when actively composing arguments to an arg-accepting command (/run, /steer, /queue).
	const exact = SLASH_COMMANDS.find(c => c.name === cmdWord || c.aliases.includes(cmdWord));
	return exact?.takesArgs === true;
}

/** Filters slash commands for autocomplete from the raw composer input. */
export function filterSlashCommands(input: string): readonly SlashCommandDef[] {
	const trimmedStart = input.trimStart();
	if (!trimmedStart.startsWith("/")) return [];
	const afterSlash = trimmedStart.slice(1);
	const spaceIdx = afterSlash.indexOf(" ");
	const query = (spaceIdx < 0 ? afterSlash : afterSlash.slice(0, spaceIdx)).toLowerCase();
	if (!query) return SLASH_COMMANDS;
	return SLASH_COMMANDS.filter(
		c => c.name.startsWith(query) || c.aliases.some(a => a.startsWith(query)),
	);
}

/** Extracts raw command text when the user enters `!command` shell notation. */
export function extractBangCommand(input: string): string | null {
	if (input.includes("\n")) return null;
	const trimmed = input.trim();
	if (!trimmed.startsWith("!")) return null;
	return trimmed.replace(/^!+\s*/, "");
}

/** Formats `/run <command>` into a clear bash-tool request for the host coding agent. */
export function formatRunAgentPrompt(command: string): string {
	return `Run this workspace command via bash and summarize the output:\n\`\`\`sh\n${command}\n\`\`\``;
}
