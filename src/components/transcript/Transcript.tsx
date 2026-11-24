import type {
	AssistantMessage,
	ImageContent,
	SessionEntry,
	TextContent,
	ToolCallContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-wire";
import { ArrowDown, Check, ChevronRight, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtClock, fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import type { ToolOpenSignal } from "../../tool-render/ToolView";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export type TranscriptViewMode = "focus" | "standard" | "detailed";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent inspector
	/** Progressive disclosure preset: focus (prose-first), standard (smart), detailed (all open). */
	viewMode?: TranscriptViewMode;
	/** Monotonic counter bumped whenever the user explicitly toggles viewMode. */
	viewSeq?: number;
	/** Current guest display name, used to highlight the user's own prompts. */
	guestName?: string;
	/** Host participant display name if known. */
	hostName?: string;
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent inspector's compact transcript. */
	phase?: ConnectionPhase;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

function fmtFullTime(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function extractPlainText(messages: readonly AssistantMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		for (const block of msg.content) {
			if (block.type === "text" && block.text.length > 0) parts.push(block.text);
		}
	}
	return parts.join("\n\n").trim();
}

function CopyTurnButton({ text }: { text: string }): ReactNode {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1800);
		return () => window.clearTimeout(timer);
	}, [copied]);

	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Clipboard write unavailable — non-fatal
		}
	};

	return (
		<button
			type="button"
			className={`tr-copy-btn${copied ? " tr-copy-btn--ok" : ""}`}
			onClick={() => void copy()}
			title={copied ? "Copied" : "Copy response"}
			aria-label={copied ? "Copied response" : "Copy response"}
		>
			{copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
			<span>{copied ? "Copied" : "Copy"}</span>
		</button>
	);
}

function ThinkingBlock({
	text,
	redacted,
	openSignal,
}: {
	text: string;
	redacted?: boolean;
	openSignal?: ToolOpenSignal;
}): ReactNode {
	const [open, setOpen] = useState(openSignal?.open ?? false);
	const appliedSeqRef = useRef<number | undefined>(openSignal?.seq);

	useEffect(() => {
		if (!openSignal || openSignal.seq === appliedSeqRef.current) return;
		appliedSeqRef.current = openSignal.seq;
		setOpen(openSignal.open);
	}, [openSignal]);

	const preview = useMemo(() => {
		if (redacted) return "Redacted by provider";
		return text.replace(/\s+/g, " ").trim();
	}, [text, redacted]);

	return (
		<div className={`tr-think${open ? " tr-think--open" : ""}`}>
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
				<ChevronRight size={12} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden />
				<span className="tr-think-label">{redacted ? "Thought (redacted)" : "Thought"}</span>
				{!open && preview && <span className="tr-think-preview">{preview}</span>}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

type ExecItem =
	| { kind: "thinking"; key: string; text: string; redacted?: boolean }
	| {
			kind: "tool";
			key: string;
			block: ToolCallContent;
			act: ActiveTool | undefined;
			result: ToolResultMessage | undefined;
			running: boolean;
			isError: boolean;
	  };

type ContentSegment =
	| { kind: "text"; key: string; text: string }
	| { kind: "exec"; key: string; items: ExecItem[] };

function summarizeExecItems(items: readonly ExecItem[]): string {
	const counts = new Map<string, number>();
	for (const item of items) {
		const label = item.kind === "thinking" ? "thought" : item.block.name;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [name, count] of counts) {
		parts.push(count > 1 ? `${name} ×${count}` : name);
	}
	return parts.join(", ");
}

function renderExecItem(
	item: ExecItem,
	host: ToolRenderHost | undefined,
	openSignal: ToolOpenSignal | undefined,
): ReactNode {
	if (item.kind === "thinking") {
		return <ThinkingBlock key={item.key} text={item.text} redacted={item.redacted} openSignal={openSignal} />;
	}
	const { block, act, result, running } = item;
	const args = act?.args ?? block.arguments;
	return (
		<ToolCard
			key={item.key}
			toolCallId={block.id}
			name={block.name}
			intent={block.intent ?? act?.intent}
			args={args}
			result={result}
			host={host}
			running={running}
			partialResult={act?.partialResult}
			openSignal={openSignal}
		/>
	);
}

function ExecutionGroup({
	items,
	viewMode,
	modeSignal,
	isLatestAssistant,
	host,
}: {
	items: readonly ExecItem[];
	viewMode: TranscriptViewMode;
	modeSignal: ToolOpenSignal | undefined;
	isLatestAssistant: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const hasRunning = items.some(it => it.kind === "tool" && it.running);
	const errorCount = items.filter(it => it.kind === "tool" && it.isError).length;

	const computeDefaultExpanded = (mode: TranscriptViewMode): boolean => {
		if (mode === "focus") return false;
		if (mode === "detailed") return true;
		// Standard mode: keep active, failed, or latest-turn steps open; fold older multi-step bursts.
		return hasRunning || errorCount > 0 || isLatestAssistant;
	};

	const [expanded, setExpanded] = useState(() => computeDefaultExpanded(viewMode));
	const [localSignal, setLocalSignal] = useState<ToolOpenSignal | undefined>(undefined);
	const [outputsOpen, setOutputsOpen] = useState(viewMode === "detailed");
	const lastModeSeqRef = useRef<number | undefined>(modeSignal?.seq);

	useEffect(() => {
		if (!modeSignal || modeSignal.seq === lastModeSeqRef.current) return;
		lastModeSeqRef.current = modeSignal.seq;
		setExpanded(computeDefaultExpanded(viewMode));
		setOutputsOpen(modeSignal.open);
		setLocalSignal(undefined);
	}, [modeSignal, viewMode, hasRunning, errorCount, isLatestAssistant]);

	useEffect(() => {
		if (hasRunning && viewMode !== "focus" && !expanded) setExpanded(true);
	}, [hasRunning, viewMode, expanded]);

	const effectiveSignal = localSignal ?? modeSignal;

	// Single item: render directly as a 1-line collapsible row (no redundant "1 step" indirection).
	if (items.length === 1) {
		return <>{renderExecItem(items[0]!, host, effectiveSignal)}</>;
	}

	const stepWord = `${items.length} steps`;
	const summary = summarizeExecItems(items);

	if (!expanded) {
		return (
			<button
				type="button"
				className={`tr-steps-collapsed${errorCount > 0 ? " tr-steps-collapsed--err" : ""}`}
				onClick={() => setExpanded(true)}
				aria-expanded={false}
			>
				<ChevronRight size={12} className="tr-chev" aria-hidden />
				{hasRunning && <span className="tr-steps-live-dot" aria-label="running" />}
				<span className="tr-steps-count">{stepWord}</span>
				<span className="tr-steps-summary">{summary}</span>
				{errorCount > 0 && <span className="tr-steps-err-badge">{errorCount} failed</span>}
			</button>
		);
	}

	const toggleOutputs = (): void => {
		const next = !outputsOpen;
		setOutputsOpen(next);
		setLocalSignal(prev => ({ open: next, seq: (prev?.seq ?? modeSignal?.seq ?? 0) + 1000 }));
	};

	return (
		<div className="tr-steps">
			<div className="tr-steps-bar">
				<button
					type="button"
					className="tr-steps-toggle"
					onClick={() => setExpanded(false)}
					aria-expanded={true}
				>
					<ChevronRight size={12} className="tr-chev tr-chev--open" aria-hidden />
					<span className="tr-steps-count">{stepWord}</span>
					{errorCount > 0 && <span className="tr-steps-err-badge">{errorCount} failed</span>}
				</button>
				<button type="button" className="tr-steps-detail-btn" onClick={toggleOutputs}>
					{outputsOpen ? "Fold outputs" : "Expand outputs"}
				</button>
			</div>
			<div className="tr-steps-rail">
				{items.map(item => renderExecItem(item, host, effectiveSignal))}
			</div>
		</div>
	);
}

function AssistantBody({
	messages,
	results,
	active,
	pending,
	viewMode,
	modeSignal,
	isLatestAssistant,
	host,
}: {
	messages: readonly AssistantMessage[];
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	viewMode: TranscriptViewMode;
	modeSignal: ToolOpenSignal | undefined;
	isLatestAssistant: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const segments = useMemo<ContentSegment[]>(() => {
		const out: ContentSegment[] = [];
		let currentExec: ExecItem[] | null = null;

		const flushExec = () => {
			if (currentExec && currentExec.length > 0) {
				out.push({ kind: "exec", key: `exec-${out.length}`, items: currentExec });
				currentExec = null;
			}
		};

		messages.forEach((msg, mIdx) => {
			msg.content.forEach((block, i) => {
				switch (block.type) {
					case "thinking":
						currentExec ??= [];
						currentExec.push({ kind: "thinking", key: `think-${mIdx}-${i}`, text: block.thinking });
						break;
					case "redactedThinking":
						currentExec ??= [];
						currentExec.push({ kind: "thinking", key: `rthink-${mIdx}-${i}`, text: "", redacted: true });
						break;
					case "toolCall": {
						currentExec ??= [];
						const act = active.get(block.id);
						const result = results.get(block.id);
						const running = !result && (act !== undefined || pending);
						const isError = result?.isError === true;
						currentExec.push({
							kind: "tool",
							key: block.id,
							block,
							act,
							result,
							running,
							isError,
						});
						break;
					}
					case "text":
						if (block.text.length > 0) {
							flushExec();
							out.push({ kind: "text", key: `text-${mIdx}-${i}`, text: block.text });
						}
						break;
					default:
						break;
				}
			});
		});
		flushExec();
		return out;
	}, [messages, active, results, pending]);

	const plainText = useMemo(() => (pending ? "" : extractPlainText(messages)), [messages, pending]);
	const lastMsg = messages[messages.length - 1];
	const stop = lastMsg?.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");

	return (
		<>
			{segments.map((seg, idx) => {
				if (seg.kind === "exec") {
					return (
						<ExecutionGroup
							key={seg.key}
							items={seg.items}
							viewMode={viewMode}
							modeSignal={modeSignal}
							isLatestAssistant={isLatestAssistant || pending}
							host={host}
						/>
					);
				}
				const isLastText =
					!pending &&
					plainText.length > 0 &&
					segments.slice(idx + 1).every(later => later.kind !== "text");
				return (
					<div key={seg.key} className="tr-prose-block">
						{pending ? <StreamingMarkdown text={seg.text} /> : <Markdown text={seg.text} />}
						{isLastText && (
							<div className="tr-prose-actions">
								<CopyTurnButton text={plainText} />
							</div>
						)}
					</div>
				);
			})}
			{failed && lastMsg && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{lastMsg.errorMessage !== undefined && lastMsg.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{lastMsg.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

function ExpandableSummaryDivider({
	label,
	subtitle,
	summary,
}: {
	label: string;
	subtitle?: string;
	summary: string;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const hasSummary = summary.trim().length > 0;

	if (!hasSummary) {
		return (
			<div className="tr-divider">
				<span>{label}</span>
			</div>
		);
	}

	return (
		<div className={`tr-compaction${open ? " tr-compaction--open" : ""}`}>
			<div className="tr-divider">
				<button
					type="button"
					className="tr-divider-btn"
					onClick={() => setOpen(v => !v)}
					aria-expanded={open}
				>
					<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden />
					<span>{label}</span>
					{subtitle && !open && <span className="tr-divider-sub">— {subtitle}</span>}
				</button>
			</div>
			{open && (
				<div className="tr-compaction-body">
					<Markdown text={summary} />
				</div>
			)}
		</div>
	);
}

interface PromptRowProps {
	sender: ReactNode;
	isSelf?: boolean;
	isHost?: boolean;
	time?: string;
	title?: string;
	children: ReactNode;
}

function PromptRow({ sender, isSelf, isHost, time, title, children }: PromptRowProps): ReactNode {
	return (
		<div
			className={`tr-row tr-row--user${isSelf ? " tr-row--self" : ""}${isHost ? " tr-row--host" : ""}`}
		>
			<div className="tr-row-head">
				<div className="tr-row-sender" title={title}>
					<span className="tr-gutter">{sender}</span>
					{isSelf && <span className="tr-you-tag">you</span>}
					{time && <span className="tr-time">{time}</span>}
				</div>
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

type AssistantEntry = Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage };

interface AssistantTurnProps {
	entries: readonly AssistantEntry[];
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	isLatestAssistant: boolean;
	viewMode: TranscriptViewMode;
	modeSignal: ToolOpenSignal | undefined;
	host?: ToolRenderHost;
}

function assistantTurnEqual(prev: AssistantTurnProps, next: AssistantTurnProps): boolean {
	if (
		prev.entries.length !== next.entries.length ||
		prev.host !== next.host ||
		prev.isLatestAssistant !== next.isLatestAssistant ||
		prev.viewMode !== next.viewMode ||
		prev.modeSignal !== next.modeSignal
	) {
		return false;
	}
	for (let i = 0; i < next.entries.length; i++) {
		const pe = prev.entries[i]!;
		const ne = next.entries[i]!;
		if (pe !== ne) return false;
		for (const block of ne.message.content) {
			if (block.type !== "toolCall") continue;
			if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
			if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
		}
	}
	return true;
}

const AssistantTurnRow = memo(function AssistantTurnRow({
	entries,
	results,
	active,
	isLatestAssistant,
	viewMode,
	modeSignal,
	host,
}: AssistantTurnProps): ReactNode {
	const messages = useMemo(() => entries.map(e => e.message), [entries]);
	return (
		<div className="tr-row tr-row--assistant">
			<div className="tr-body">
				<AssistantBody
					messages={messages}
					results={results}
					active={active}
					pending={false}
					viewMode={viewMode}
					modeSignal={modeSignal}
					isLatestAssistant={isLatestAssistant}
					host={host}
				/>
			</div>
		</div>
	);
}, assistantTurnEqual);

interface SingleEntryProps {
	entry: SessionEntry;
	guestName?: string;
	hostName?: string;
}

const SingleEntryRow = memo(function SingleEntryRow({ entry, guestName, hostName }: SingleEntryProps): ReactNode {
	const clock = fmtClock(entry.timestamp);
	const fullTime = fmtFullTime(entry.timestamp);

	switch (entry.type) {
		case "message": {
			if (entry.message.role !== "user") return null;
			return (
				<PromptRow sender={hostName || "Host"} isHost time={clock} title={fullTime}>
					<MsgContent content={entry.message.content} />
				</PromptRow>
			);
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				const isSelf = Boolean(guestName && from === guestName);
				return (
					<PromptRow sender={<span className="tr-badge">{from}</span>} isSelf={isSelf} time={clock} title={fullTime}>
						<MsgContent content={entry.content} />
					</PromptRow>
				);
			}
			if (!entry.display) return null;
			return (
				<div className="tr-row tr-row--custom">
					<div className="tr-body">
						<div className="tr-custom">
							<span className="tr-chip">{entry.customType}</span>
							<MsgContent content={entry.content} />
						</div>
					</div>
				</div>
			);
		}
		case "compaction":
			return (
				<ExpandableSummaryDivider
					label={`Context compacted · ${fmtTokens(entry.tokensBefore)} tokens`}
					subtitle={entry.shortSummary}
					summary={entry.summary}
				/>
			);
		case "branch_summary":
			return <ExpandableSummaryDivider label="Branch summary" summary={entry.summary} />;
		default:
			return null;
	}
});

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	return entry.type === "message" && entry.message.role === "assistant";
}

function willEntryRender(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return entry.message.role === "user" || entry.message.role === "assistant";
		case "custom_message":
			return entry.customType === "collab-prompt" || entry.display;
		case "compaction":
		case "branch_summary":
		case "model_change":
		case "thinking_level_change":
			return true;
		default:
			return false;
	}
}

type RenderItem =
	| { kind: "assistantTurn"; key: string; entries: AssistantEntry[]; isLatestAssistant: boolean }
	| { kind: "entry"; entry: SessionEntry }
	| { kind: "markers"; key: string; parts: string[]; title?: string };

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		working,
		compact,
		viewMode = "standard",
		viewSeq = 0,
		guestName,
		hostName,
		host,
		phase,
	} = props;

	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const [atBottom, setAtBottom] = useState(true);

	const modeSignal = useMemo<ToolOpenSignal | undefined>(() => {
		if (viewSeq === 0 && viewMode === "standard") return undefined;
		return { open: viewMode === "detailed", seq: viewSeq };
	}, [viewMode, viewSeq]);

	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// Coalesce consecutive assistant messages (across paired toolResults) into one cohesive turn
	// and coalesce consecutive model/thinking markers.
	const { renderItems, tailAfterAssistant } = useMemo(() => {
		const items: RenderItem[] = [];
		let lastAssistantTurnIdx = -1;
		let i = 0;

		while (i < visible.length) {
			const entry = visible[i]!;
			if (!willEntryRender(entry)) {
				i++;
				continue;
			}
			if (entry.type === "model_change" || entry.type === "thinking_level_change") {
				const parts: string[] = [];
				const firstId = entry.id;
				const title = fmtFullTime(entry.timestamp);
				while (i < visible.length) {
					const cur = visible[i]!;
					if (!willEntryRender(cur)) {
						i++;
						continue;
					}
					if (cur.type === "model_change") {
						parts.push(`model: ${cur.model}`);
						i++;
					} else if (cur.type === "thinking_level_change") {
						parts.push(`effort: ${cur.thinkingLevel ?? "off"}`);
						i++;
					} else {
						break;
					}
				}
				items.push({ kind: "markers", key: `mk-${firstId}`, parts, title });
				continue;
			}
			if (isAssistantEntry(entry)) {
				const group: AssistantEntry[] = [];
				while (i < visible.length) {
					const cur = visible[i]!;
					if (!willEntryRender(cur)) {
						i++;
						continue;
					}
					if (!isAssistantEntry(cur)) break;
					group.push(cur);
					i++;
					const stop = cur.message.stopReason;
					if (stop === "error" || stop === "aborted") break;
				}
				lastAssistantTurnIdx = items.length;
				items.push({
					kind: "assistantTurn",
					key: group[0]!.id,
					entries: group,
					isLatestAssistant: false,
				});
				continue;
			}
			items.push({ kind: "entry", entry });
			i++;
		}

		if (stream === null && lastAssistantTurnIdx >= 0) {
			const lastTurn = items[lastAssistantTurnIdx];
			if (lastTurn && lastTurn.kind === "assistantTurn") {
				items[lastAssistantTurnIdx] = { ...lastTurn, isLatestAssistant: true };
			}
		}
		const tailIsAssistant = items.length > 0 && items[items.length - 1]?.kind === "assistantTurn";
		return { renderItems: items, tailAfterAssistant: tailIsAssistant };
	}, [visible, stream]);

	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		setAtBottom(true);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	// Attach one-click copy buttons to Markdown fenced code blocks without touching SSR HTML.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const pres = root.querySelectorAll(".tr-md pre");
		for (const el of pres) {
			const pre = el as HTMLElement;
			if (pre.dataset.copyBound === "1") continue;
			pre.dataset.copyBound = "1";
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "tr-code-copy";
			btn.setAttribute("aria-label", "Copy code");
			btn.textContent = "Copy";
			let resetTimer: number | undefined;
			btn.addEventListener("click", () => {
				const codeText = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
				void navigator.clipboard
					?.writeText(codeText)
					.then(() => {
						btn.textContent = "Copied";
						btn.classList.add("tr-code-copy--ok");
						if (resetTimer !== undefined) window.clearTimeout(resetTimer);
						resetTimer = window.setTimeout(() => {
							btn.textContent = "Copy";
							btn.classList.remove("tr-code-copy--ok");
						}, 1600);
					})
					.catch(() => {});
			});
			pre.appendChild(btn);
		}
	}, [visible, stream]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	const jumpToLatest = (): void => {
		const el = rootRef.current;
		setPinnedStart(null);
		setAtBottom(true);
		lockRef.current = true;
		if (el !== null) {
			el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
		}
	};

	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	const settled = phase === undefined || phase === "live";
	const streamingNow = working || stream !== null;
	const streamList = useMemo(() => (stream !== null ? [stream] : []), [stream]);

	return (
		<div className="tr-wrap">
			<div
				ref={rootRef}
				className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
				onScroll={() => {
					const el = rootRef.current;
					if (el === null) return;
					updateTranscriptTailLock(el, lockRef);
					setAtBottom(lockRef.current);
					if (lockRef.current) {
						if (pinnedStart !== null) setPinnedStart(null);
					} else if (pinnedStart === null) {
						setPinnedStart(start);
					}
					if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
				}}
			>
				{settled && entries.length === 0 && stream === null && !working && (
					<div className="tr-empty">Connected — send a prompt below or wait for host activity.</div>
				)}
				{start > 0 && (
					<button type="button" className="tr-earlier" onClick={showEarlier}>
						show {start.toLocaleString("en-US")} earlier
					</button>
				)}
				{renderItems.map(item => {
					if (item.kind === "markers") {
						return (
							<div key={item.key} className="tr-row tr-row--marker" title={item.title}>
								<span className="tr-marker">{item.parts.join("  ·  ")}</span>
							</div>
						);
					}
					if (item.kind === "assistantTurn") {
						return (
							<AssistantTurnRow
								key={item.key}
								entries={item.entries}
								results={results}
								active={activeTools}
								isLatestAssistant={item.isLatestAssistant}
								viewMode={viewMode}
								modeSignal={modeSignal}
								host={host}
							/>
						);
					}
					return (
						<SingleEntryRow
							key={item.entry.id}
							entry={item.entry}
							guestName={guestName}
							hostName={hostName}
						/>
					);
				})}
				{stream !== null && (
					<div className={`tr-row tr-row--assistant${tailAfterAssistant ? " tr-row--continued" : ""}`}>
						<div className="tr-body">
							<AssistantBody
								messages={streamList}
								results={results}
								active={activeTools}
								pending={!streamDone}
								viewMode={viewMode}
								modeSignal={modeSignal}
								isLatestAssistant={true}
								host={host}
							/>
						</div>
					</div>
				)}
				{tailTools.length > 0 && (
					<div
						className={`tr-row tr-row--assistant${tailAfterAssistant || stream !== null ? " tr-row--continued" : ""}`}
					>
						<div className="tr-body">
							{tailTools.map(tool => (
								<ToolCard
									key={tool.toolCallId}
									toolCallId={tool.toolCallId}
									name={tool.toolName}
									intent={tool.intent}
									args={tool.args}
									running
									partialResult={tool.partialResult}
									openSignal={modeSignal}
									host={host}
								/>
							))}
						</div>
					</div>
				)}
				{working && stream === null && activeTools.size === 0 && (
					<div className={`tr-row tr-row--assistant${tailAfterAssistant ? " tr-row--continued" : ""}`}>
						<div className="tr-body">
							<div className="tr-shimmer">thinking…</div>
						</div>
					</div>
				)}
			</div>
			{compact !== true && !atBottom && entries.length > 0 && (
				<button type="button" className="tr-jump" onClick={jumpToLatest} aria-label="Jump to latest messages">
					{streamingNow && <span className="tr-jump-dot" aria-hidden />}
					<ArrowDown size={13} aria-hidden />
					<span>Latest</span>
				</button>
			)}
		</div>
	);
}
