import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import {
	dropQueuedPrompts,
	type PendingPrompt,
	promoteQueuedToSending,
	reconcilePendingPrompts,
} from "../src/lib/prompt-queue";

function collabEntry(id: string, from: string, text: string, withImage = false): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-11-24T06:00:00Z",
		type: "custom_message",
		customType: "collab-prompt",
		content: withImage
			? [
					{ type: "text", text },
					{ type: "image", mimeType: "image/png", data: "aW1n" },
				]
			: text,
		details: { from },
		display: true,
	};
}

describe("prompt-queue optimistic send & queue reconciliation", () => {
	it("keeps queued prompts visible while unrelated assistant entries stream, then reconciles on dequeue", () => {
		const initialEntries: SessionEntry[] = [collabEntry("e0", "kai", "initial")];
		const pending: PendingPrompt[] = [
			{
				id: "p1",
				text: "follow-up check",
				images: [],
				mode: "queued",
				createdAt: 1000,
				baseEntryCount: initialEntries.length,
			},
		];

		// Unrelated entry from another guest does not consume our queued prompt.
		const midEntries: SessionEntry[] = [...initialEntries, collabEntry("e1", "other-guest", "follow-up check")];
		expect(reconcilePendingPrompts(pending, midEntries, "kai", 2000)).toBe(pending);

		// Authoritative host entry for kai dequeues and reconciles cleanly.
		const finalEntries: SessionEntry[] = [...midEntries, collabEntry("e2", "kai", "follow-up check")];
		expect(reconcilePendingPrompts(pending, finalEntries, "kai", 3000)).toEqual([]);
	});

	it("claims identical consecutive prompts in strict FIFO order without premature double removal", () => {
		const pending: PendingPrompt[] = [
			{ id: "p1", text: "continue", images: [], mode: "sending", createdAt: 1000, baseEntryCount: 0 },
			{ id: "p2", text: "continue", images: [], mode: "queued", createdAt: 1100, baseEntryCount: 0 },
		];

		const oneConfirmed = [collabEntry("e1", "guest", "continue")];
		const afterFirst = reconcilePendingPrompts(pending, oneConfirmed, "guest", 1500);
		expect(afterFirst.map(p => p.id)).toEqual(["p2"]);

		const twoConfirmed = [...oneConfirmed, collabEntry("e2", "guest", "continue")];
		expect(reconcilePendingPrompts(afterFirst, twoConfirmed, "guest", 2000)).toEqual([]);
	});

	it("matches prompts carrying image attachments", () => {
		const img = { type: "image" as const, mimeType: "image/png", data: "aW1n" };
		const pending: PendingPrompt[] = [
			{ id: "p-img", text: "inspect screenshot", images: [img], mode: "sending", createdAt: 1000, baseEntryCount: 0 },
		];

		// Text-only entry should not match an image-bearing prompt.
		expect(reconcilePendingPrompts(pending, [collabEntry("e1", "guest", "inspect screenshot", false)], "guest", 1200)).toHaveLength(1);
		// Entry with matching text + image count reconciles.
		expect(reconcilePendingPrompts(pending, [collabEntry("e2", "guest", "inspect screenshot", true)], "guest", 1200)).toEqual([]);
	});

	it("promotes queued prompts to sending on deliver-queue and drops queued prompts on abort", () => {
		const pending: PendingPrompt[] = [
			{ id: "p1", text: "first", images: [], mode: "sending", createdAt: 1000, baseEntryCount: 0 },
			{ id: "p2", text: "second", images: [], mode: "queued", createdAt: 1200, baseEntryCount: 0 },
		];

		const promoted = promoteQueuedToSending(pending, 2000);
		expect(promoted.map(p => p.mode)).toEqual(["sending", "sending"]);

		const dropped = dropQueuedPrompts(pending);
		expect(dropped.map(p => p.id)).toEqual(["p1"]);
	});
});
