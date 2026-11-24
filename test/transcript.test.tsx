import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { followTranscriptTail, Transcript, updateTranscriptTailLock } from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	viewMode?: "focus" | "standard" | "detailed";
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={null}
			streamDone={true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
			viewMode={props.viewMode}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});
});

describe("Transcript tail-follow scroll operations", () => {
	it("restores tail-follow when a connection becomes live", () => {
		const element = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 };
		const lock = { current: false };

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_000);

		element.scrollTop = 600;
		updateTranscriptTailLock(element, lock);
		expect(lock.current).toBe(false);

		element.scrollHeight = 1_200;
		followTranscriptTail(element, lock);
		expect(element.scrollTop).toBe(600);

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_200);
	});
});

describe("Transcript windowing", () => {
	it("mounts only the newest 100 entries and offers the rest", () => {
		const entries: SessionEntry[] = Array.from({ length: 250 }, (_, i) => ({
			type: "message",
			id: `m${i}`,
			parentId: i === 0 ? null : `m${i - 1}`,
			timestamp: "2026-07-15T00:00:00Z",
			message: { role: "user", content: `message-${i}-end`, timestamp: i },
		}));

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user")).toBe(100);
		expect(html).toContain("message-249-end");
		expect(html).toContain("message-150-end");
		expect(html).not.toContain("message-149-end");
		expect(html).toContain("show 150 earlier");
	});
});

describe("Transcript progressive disclosure & coalescing", () => {
	const multiStepEntries: SessionEntry[] = [
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-07-15T00:00:00Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "src/a.ts" },
						intent: "Read a.ts",
					},
				],
				model: "test/model",
				usage: assistantUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-07-15T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "FIRST_OUTPUT_BODY" }],
				isError: false,
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "a2",
			parentId: "r1",
			timestamp: "2026-07-15T00:00:02Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-2",
						name: "bash",
						arguments: { command: "bun test" },
						intent: "Run tests",
					},
				],
				model: "test/model",
				usage: assistantUsage(),
				stopReason: "toolUse",
				timestamp: 3,
			},
		},
		{
			type: "message",
			id: "r2",
			parentId: "a2",
			timestamp: "2026-07-15T00:00:03Z",
			message: {
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "bash",
				content: [{ type: "text", text: "SECOND_OUTPUT_BODY" }],
				isError: false,
				timestamp: 4,
			},
		},
		{
			type: "message",
			id: "a3",
			parentId: "r2",
			timestamp: "2026-07-15T00:00:04Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "All checks passed." }],
				model: "test/model",
				usage: assistantUsage(),
				stopReason: "stop",
				timestamp: 5,
			},
		},
	];

	it("coalesces consecutive assistant steps across toolResults and expands in standard mode", () => {
		const html = renderTranscript({ entries: multiStepEntries, working: false, viewMode: "standard" });
		expect(countElements(html, ".tr-row--assistant")).toBe(1);
		expect(html).toContain("2 steps");
		expect(countElements(html, ".tv-card")).toBe(2);
		expect(countElements(html, ".tv-body")).toBe(0);
	});

	it("folds multi-step traces in focus mode and opens all outputs in detailed mode", () => {
		const focusHtml = renderTranscript({ entries: multiStepEntries, working: false, viewMode: "focus" });
		expect(countElements(focusHtml, ".tr-steps-collapsed")).toBe(1);
		expect(focusHtml).toContain("2 steps");
		expect(countElements(focusHtml, ".tv-card")).toBe(0);

		const detailedHtml = renderTranscript({ entries: multiStepEntries, working: false, viewMode: "detailed" });
		expect(countElements(detailedHtml, ".tv-card")).toBe(2);
		expect(countElements(detailedHtml, ".tv-body")).toBe(2);
		expect(detailedHtml).toContain("FIRST_OUTPUT_BODY");
		expect(detailedHtml).toContain("SECOND_OUTPUT_BODY");
	});

	it("auto-expands failed tool outputs in standard mode while keeping focus mode folded", () => {
		const errorEntries: SessionEntry[] = [
			multiStepEntries[0]!,
			{
				type: "message",
				id: "r1-err",
				parentId: "a1",
				timestamp: "2026-07-15T00:00:01Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "ENOENT_DIAGNOSTIC_BODY" }],
					isError: true,
					timestamp: 2,
				},
			},
			multiStepEntries[2]!,
			multiStepEntries[3]!,
			multiStepEntries[4]!,
		];

		const standardHtml = renderTranscript({ entries: errorEntries, working: false, viewMode: "standard" });
		expect(countElements(standardHtml, ".tv-body")).toBe(1);
		expect(standardHtml).toContain("ENOENT_DIAGNOSTIC_BODY");
		expect(standardHtml).not.toContain("SECOND_OUTPUT_BODY");

		const focusHtml = renderTranscript({ entries: errorEntries, working: false, viewMode: "focus" });
		expect(countElements(focusHtml, ".tr-steps-collapsed")).toBe(1);
		expect(focusHtml).toContain("1 failed");
		expect(focusHtml).not.toContain("ENOENT_DIAGNOSTIC_BODY");
	});
});
