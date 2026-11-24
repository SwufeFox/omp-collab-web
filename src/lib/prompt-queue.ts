import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";

export interface PendingPrompt {
	readonly id: string;
	readonly text: string;
	readonly images: readonly ImageContent[];
	readonly mode: "sending" | "queued";
	readonly createdAt: number;
	/** Snapshot of `entries.length` when the prompt was dispatched. */
	readonly baseEntryCount: number;
}

function normalizeText(s: string): string {
	return s.replaceAll("\r\n", "\n").trim();
}

function extractEntryPromptContent(
	content: string | readonly (TextContent | ImageContent)[],
): { text: string; imageCount: number } {
	if (typeof content === "string") {
		return { text: normalizeText(content), imageCount: 0 };
	}
	const texts: string[] = [];
	let imageCount = 0;
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
		else if (block.type === "image") imageCount++;
	}
	return { text: normalizeText(texts.join("\n")), imageCount };
}

function extractEntrySender(details: unknown): string | null {
	if (details !== null && typeof details === "object" && typeof (details as Record<string, unknown>).from === "string") {
		return (details as Record<string, unknown>).from as string;
	}
	return null;
}

/**
 * Reconciles optimistic `sending` and `queued` prompts against authoritative `entries`
 * from the host. Claims matching `collab-prompt` entries in strict FIFO order so sending
 * identical short prompts twice ("ok", "ok") reconciles one pending item per host entry.
 */
export function reconcilePendingPrompts(
	pending: readonly PendingPrompt[],
	entries: readonly SessionEntry[],
	guestName: string | undefined,
	now = Date.now(),
): readonly PendingPrompt[] {
	if (pending.length === 0) return pending;
	const expectedSender = guestName ? guestName.trim().slice(0, 64) : undefined;
	const claimedEntryIds = new Set<string>();
	let changed = false;
	const kept: PendingPrompt[] = [];

	for (const item of pending) {
		const targetText = normalizeText(item.text);
		const startIdx = Math.max(0, Math.min(item.baseEntryCount, entries.length));
		let matched = false;

		for (let i = startIdx; i < entries.length; i++) {
			const entry = entries[i]!;
			if (claimedEntryIds.has(entry.id)) continue;
			if (entry.type !== "custom_message" || entry.customType !== "collab-prompt") continue;

			const sender = extractEntrySender(entry.details);
			if (expectedSender && sender !== null && sender !== expectedSender) continue;

			const parsed = extractEntryPromptContent(entry.content);
			if (parsed.text === targetText && parsed.imageCount === item.images.length) {
				claimedEntryIds.add(entry.id);
				matched = true;
				break;
			}
		}

		if (matched) {
			changed = true;
			continue;
		}

		// Drop orphaned `sending` ghosts if unacknowledged after 20s (e.g. dropped frame before reconnect).
		if (item.mode === "sending" && now - item.createdAt > 20_000) {
			changed = true;
			continue;
		}

		kept.push(item);
	}

	return changed ? kept : pending;
}

/** Promotes all `queued` prompts to `sending` when `deliver-queue` is triggered or a turn drains. */
export function promoteQueuedToSending(pending: readonly PendingPrompt[], now = Date.now()): readonly PendingPrompt[] {
	let changed = false;
	const next = pending.map(item => {
		if (item.mode !== "queued") return item;
		changed = true;
		return { ...item, mode: "sending" as const, createdAt: now };
	});
	return changed ? next : pending;
}

/** Drops locally tracked `queued` items when the user aborts the active run (`Stop`). */
export function dropQueuedPrompts(pending: readonly PendingPrompt[]): readonly PendingPrompt[] {
	const next = pending.filter(item => item.mode !== "queued");
	return next.length === pending.length ? pending : next;
}
