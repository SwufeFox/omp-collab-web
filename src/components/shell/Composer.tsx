import type { CollabUiRequest, ImageContent } from "@oh-my-pi/pi-wire";
import { Clock, CornerDownLeft, CornerDownRight, Eye, ImagePlus, SendHorizontal, ShieldAlert, Square, X } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import type { PendingPrompt } from "../../lib/prompt-queue";

export interface ComposerProps {
	client: GuestClient;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Host is currently unwinding an aborted turn. */
	aborting?: boolean;
	/** Prompts queued behind the running turn on the host. */
	queuedMessageCount: number;
	/** Locally tracked queued follow-ups waiting for the active turn to finish. */
	queuedPrompts?: readonly PendingPrompt[];
	/** Optional per-session key to preserve unsent text across reconnects in sessionStorage. */
	draftKey?: string;
	/** Optional coordinator hook for optimistic send/queue tracking; falls back to client.sendPrompt. */
	onDispatchPrompt?(payload: { text: string; images: readonly ImageContent[]; followUp: boolean }): void;
	/** Optional coordinator hook when delivering queued messages immediately. */
	onDeliverQueue?(): void;
	/** Optional coordinator hook when aborting the active turn. */
	onAbortTriggered?(): void;
	/** Opens full-screen preview when clicking an attached image thumbnail. */
	onPreviewImage?(src: string): void;
}

interface DraftAttachment {
	id: string;
	name: string;
	image: ImageContent;
	previewUrl: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY = 40;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Textarea metrics: line-height 21px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 21;
const PAD_Y = 16;
const MAX_ROWS = 8;

export function autosizeTextarea(el: HTMLTextAreaElement | null, maxRows = MAX_ROWS, linePx = LINE_PX, padY = PAD_Y): void {
	if (!el) return;
	const minHeight = linePx + padY;
	// Fast path for single-line / cleared state: avoids forced height=0 reflow on every send/queue.
	if (el.value.length === 0) {
		el.style.height = `${minHeight}px`;
		el.style.overflowY = "hidden";
		return;
	}
	el.style.height = "0px";
	const max = maxRows * linePx + padY;
	el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
export function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

function readDraft(key: string | undefined): string {
	if (!key || typeof sessionStorage === "undefined") return "";
	try {
		return sessionStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function writeDraft(key: string | undefined, value: string): void {
	if (!key || typeof sessionStorage === "undefined") return;
	try {
		if (value) sessionStorage.setItem(key, value);
		else sessionStorage.removeItem(key);
	} catch {
		// storage unavailable
	}
}

function fileToAttachment(file: File): Promise<DraftAttachment> {
	return new Promise((resolve, reject) => {
		if (!ALLOWED_MIME.has(file.type)) {
			reject(new Error(`Unsupported image type (${file.type || "unknown"}). Use PNG, JPEG, WebP, or GIF.`));
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			reject(new Error(`Image "${file.name || "attachment"}" exceeds the 8 MB limit.`));
			return;
		}
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("Failed to read image file."));
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			const comma = dataUrl.indexOf(",");
			if (comma < 0) {
				reject(new Error("Failed to encode image."));
				return;
			}
			resolve({
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				name: file.name || "pasted-image",
				image: {
					type: "image",
					mimeType: file.type,
					data: dataUrl.slice(comma + 1),
				},
				previewUrl: dataUrl,
			});
		};
		reader.readAsDataURL(file);
	});
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosizeTextarea(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="Type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={13} aria-hidden /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

interface AskSelectProps {
	request: Extract<CollabUiRequest, { kind: "select" }>;
	onSelect(label: string): void;
	onCancel(): void;
}

function AskSelect({ request, onSelect, onCancel }: AskSelectProps): ReactNode {
	const count = request.options.length;
	const [activeIdx, setActiveIdx] = useState(() => {
		const init = request.initialIndex ?? 0;
		return init >= 0 && init < count ? init : 0;
	});

	useEffect(() => {
		const init = request.initialIndex ?? 0;
		setActiveIdx(init >= 0 && init < count ? init : 0);
	}, [request.reqId, request.initialIndex, count]);

	useEffect(() => {
		if (count === 0) return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const active = document.activeElement as HTMLElement | null;
			if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIdx(i => (i + 1) % count);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIdx(i => (i - 1 + count) % count);
				return;
			}
			if (e.key === "Enter") {
				const opt = request.options[activeIdx];
				if (opt !== undefined) {
					e.preventDefault();
					onSelect(typeof opt === "string" ? opt : opt.label);
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
				return;
			}
			if (e.key >= "1" && e.key <= "9") {
				const idx = Number(e.key) - 1;
				const opt = request.options[idx];
				if (opt !== undefined) {
					e.preventDefault();
					onSelect(typeof opt === "string" ? opt : opt.label);
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [count, activeIdx, request.options, onSelect, onCancel]);

	return (
		<div className="sh-ask-options">
			{request.options.map((option, index) => {
				const label = typeof option === "string" ? option : option.label;
				const checked = request.checkedIndices?.includes(index) ?? false;
				const active = index === activeIdx;
				return (
					<button
						key={`${request.reqId}-${index}-${label}`}
						type="button"
						className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}${active ? " sh-ask-option-active" : ""}`}
						onMouseEnter={() => setActiveIdx(index)}
						onClick={() => onSelect(label)}
					>
						<span className="sh-ask-option-marker">
							{request.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
						</span>
						<span className="sh-ask-option-copy">
							<span className="sh-ask-option-label">{label}</span>
							{typeof option !== "string" && option.description && (
								<span className="sh-ask-option-description">{option.description}</span>
							)}
						</span>
						{index < 9 && <kbd className="sh-ask-kbd">{index + 1}</kbd>}
					</button>
				);
			})}
		</div>
	);
}

const EMPTY_QUEUED: readonly PendingPrompt[] = [];

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	uiRequest,
	working,
	aborting = false,
	queuedMessageCount,
	queuedPrompts = EMPTY_QUEUED,
	draftKey,
	onDispatchPrompt,
	onDeliverQueue,
	onAbortTriggered,
	onPreviewImage,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(() => readDraft(draftKey));
	const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [localStopping, setLocalStopping] = useState(false);
	const [delivering, setDelivering] = useState(false);

	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const historyRef = useRef<string[]>([]);
	const historyIdxRef = useRef(-1);
	const savedDraftRef = useRef("");
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const isStopping = busy && (aborting || localStopping);
	const totalQueued = Math.max(queuedMessageCount, queuedPrompts.length);
	const peerQueuedExtra = Math.max(0, queuedMessageCount - queuedPrompts.length);
	const showQueueShelf = totalQueued > 0 && (busy || queuedPrompts.length > 0);
	const hasContent = text.trim().length > 0 || attachments.length > 0;
	const canSend = canPrompt && hasContent;

	useEffect(() => {
		if (!busy) {
			setLocalStopping(false);
			setDelivering(false);
		}
	}, [busy]);

	useEffect(() => {
		if (totalQueued === 0) setDelivering(false);
	}, [totalQueued]);

	useEffect(() => {
		writeDraft(draftKey, text);
	}, [draftKey, text]);

	useLayoutEffect(() => {
		autosizeTextarea(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		if (!canPrompt || uiRequest !== null) return;
		const onWindowKeyDown = (e: globalThis.KeyboardEvent): void => {
			if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			const active = document.activeElement as HTMLElement | null;
			if (
				active &&
				(active.tagName === "INPUT" ||
					active.tagName === "TEXTAREA" ||
					active.tagName === "SELECT" ||
					active.isContentEditable)
			) {
				return;
			}
			e.preventDefault();
			taRef.current?.focus();
		};
		window.addEventListener("keydown", onWindowKeyDown);
		return () => window.removeEventListener("keydown", onWindowKeyDown);
	}, [canPrompt, uiRequest]);

	const ingestFiles = useCallback(async (files: readonly File[]): Promise<void> => {
		if (files.length === 0) return;
		setAttachError(null);
		const nextItems: DraftAttachment[] = [];
		for (const file of files) {
			try {
				nextItems.push(await fileToAttachment(file));
			} catch (err) {
				setAttachError(err instanceof Error ? err.message : String(err));
			}
		}
		if (nextItems.length === 0) return;
		setAttachments(prev => {
			const combined = [...prev, ...nextItems];
			if (combined.length > MAX_IMAGES) {
				setAttachError(`Up to ${MAX_IMAGES} images can be attached per prompt.`);
				return combined.slice(0, MAX_IMAGES);
			}
			return combined;
		});
		taRef.current?.focus({ preventScroll: true });
	}, []);

	const commitPrompt = useCallback(
		(followUp: boolean): void => {
			const trimmed = text.trim();
			if ((!trimmed && attachments.length === 0) || !live || readOnly) return;
			const imgs = attachments.map(a => a.image);
			if (trimmed) {
				const hist = historyRef.current;
				if (hist[hist.length - 1] !== trimmed) {
					hist.push(trimmed);
					if (hist.length > MAX_HISTORY) hist.shift();
				}
			}
			historyIdxRef.current = -1;
			savedDraftRef.current = "";

			if (onDispatchPrompt) {
				onDispatchPrompt({ text: trimmed, images: imgs, followUp });
			} else {
				client.sendPrompt(trimmed, imgs.length > 0 ? imgs : undefined, followUp ? { followUp: true } : undefined);
			}

			setText("");
			setAttachments([]);
			setAttachError(null);
			writeDraft(draftKey, "");
			taRef.current?.focus({ preventScroll: true });
		},
		[attachments, client, draftKey, live, onDispatchPrompt, readOnly, text],
	);

	const triggerDeliverQueue = useCallback((): void => {
		if (!canPrompt || totalQueued === 0) return;
		setDelivering(true);
		if (onDeliverQueue) onDeliverQueue();
		else client.sendDeliverQueue();
		taRef.current?.focus({ preventScroll: true });
	}, [canPrompt, client, onDeliverQueue, totalQueued]);

	const triggerAbort = useCallback((): void => {
		if (!live) return;
		setLocalStopping(true);
		if (onAbortTriggered) onAbortTriggered();
		else client.sendAbort();
	}, [client, live, onAbortTriggered]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Escape") {
			e.currentTarget.blur();
			return;
		}

		// Prompt history recall with ArrowUp / ArrowDown when input is empty or already browsing history.
		if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !(e.nativeEvent.isComposing || composingRef.current)) {
			const hist = historyRef.current;
			if (e.key === "ArrowUp" && hist.length > 0) {
				const atTopBoundary = text.length === 0 || (historyIdxRef.current !== -1 && e.currentTarget.selectionStart === 0);
				if (atTopBoundary) {
					e.preventDefault();
					if (historyIdxRef.current === -1) {
						savedDraftRef.current = text;
						historyIdxRef.current = hist.length - 1;
					} else if (historyIdxRef.current > 0) {
						historyIdxRef.current -= 1;
					}
					const recalled = hist[historyIdxRef.current] ?? "";
					setText(recalled);
					return;
				}
			}
			if (e.key === "ArrowDown" && historyIdxRef.current !== -1) {
				const atEndBoundary = e.currentTarget.selectionEnd === text.length;
				if (atEndBoundary) {
					e.preventDefault();
					if (historyIdxRef.current < hist.length - 1) {
						historyIdxRef.current += 1;
						setText(hist[historyIdxRef.current] ?? "");
					} else {
						historyIdxRef.current = -1;
						setText(savedDraftRef.current);
					}
					return;
				}
			}
		}

		// Ctrl+Enter / Cmd+Enter / Alt+Enter while working: steer the active turn immediately.
		if (busy && e.key === "Enter" && (e.ctrlKey || e.metaKey || e.altKey) && !e.shiftKey) {
			if (!(e.nativeEvent.isComposing || composingRef.current) && hasContent) {
				e.preventDefault();
				commitPrompt(false);
			}
			return;
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			// Empty Enter with queued messages while busy: deliver queued messages immediately (TUI parity).
			if (busy && !hasContent && totalQueued > 0 && canPrompt) {
				e.preventDefault();
				triggerDeliverQueue();
				return;
			}
			if (hasContent) {
				e.preventDefault();
				commitPrompt(busy);
			}
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		if (!canPrompt) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			e.preventDefault();
			void ingestFiles(imageFiles);
		}
	};

	const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
		const files = e.target.files ? Array.from(e.target.files) : [];
		e.target.value = "";
		if (files.length > 0) void ingestFiles(files);
	};

	const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
		if (!canPrompt) return;
		if (Array.from(e.dataTransfer.types).includes("Files")) {
			e.preventDefault();
			if (!dragOver) setDragOver(true);
		}
	};

	const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
		if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
		setDragOver(false);
	};

	const onDrop = (e: DragEvent<HTMLDivElement>): void => {
		if (!canPrompt) return;
		setDragOver(false);
		const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
		if (files.length > 0) {
			e.preventDefault();
			void ingestFiles(files);
		}
	};

	if (uiRequest && canPrompt) {
		const isApproval = uiRequest.kind === "select" && uiRequest.approval === true;
		return (
			<div className="sh-composer sh-composer-ask">
				<div className={`sh-ask-card${isApproval ? " sh-ask-card-approval" : ""}`}>
					{isApproval && (
						<div className="sh-ask-eyebrow">
							<ShieldAlert size={13} aria-hidden />
							<span>Approval required</span>
						</div>
					)}
					<div className="sh-ask-title">{uiRequest.title}</div>
					{uiRequest.kind === "select" && uiRequest.helpText && (
						<div className="sh-ask-help">{uiRequest.helpText}</div>
					)}
					{uiRequest.kind === "select" ? (
						<AskSelect
							request={uiRequest}
							onSelect={label => client.sendUiResponse(uiRequest.reqId, label)}
							onCancel={() => client.sendUiResponse(uiRequest.reqId)}
						/>
					) : (
						<AskEditor
							key={uiRequest.reqId}
							prefill={uiRequest.prefill}
							onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						/>
					)}
					<div className="sh-composer-actions sh-ask-actions">
						<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
							Cancel
						</button>
						{busy && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={triggerAbort}
								disabled={!live || isStopping}
								title="stop the current turn"
							>
								<Square size={11} aria-hidden />{" "}
								<span className="sh-btn-label">{isStopping ? "Stopping…" : "Stop"}</span>
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}

	if (readOnly) {
		return (
			<div className="sh-composer sh-composer-readonly">
				<div className="sh-readonly-bar" role="status">
					<Eye size={14} aria-hidden />
					<span>Viewing in read-only mode</span>
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			{showQueueShelf && (
				<div className="sh-queue-shelf" role="status" aria-live="polite">
					<div className="sh-queue-head">
						<div className="sh-queue-title">
							<Clock size={12} className="sh-queue-icon" aria-hidden />
							<span>Queued</span>
							<span className="sh-queue-count">×{totalQueued}</span>
							<span className="sh-queue-sub">runs after current turn</span>
						</div>
						<button
							type="button"
							className="sh-queue-deliver"
							onClick={triggerDeliverQueue}
							disabled={!canPrompt || delivering}
							title="Interrupt active turn and run queued prompts immediately (or press Enter with empty input)"
						>
							<CornerDownLeft size={11} aria-hidden />
							<span>{delivering ? "Delivering…" : "Deliver now"}</span>
						</button>
					</div>
					{queuedPrompts.length > 0 && (
						<ol className="sh-queue-list">
							{queuedPrompts.map((item, idx) => (
								<li key={item.id} className="sh-queue-item">
									<span className="sh-queue-idx">{idx + 1}.</span>
									<span className="sh-queue-text">
										{item.text || "(image attachment)"}
									</span>
									{item.images.length > 0 && (
										<span className="sh-queue-meta">
											+{item.images.length} img
										</span>
									)}
								</li>
							))}
							{peerQueuedExtra > 0 && (
								<li className="sh-queue-item sh-queue-item-peer">
									<span>+{peerQueuedExtra} queued by other participants</span>
								</li>
							)}
						</ol>
					)}
				</div>
			)}
			<div
				className={`sh-composer-inner sh-composer-stack${dragOver ? " sh-composer-inner-drag" : ""}${showQueueShelf ? " sh-composer-inner-docked" : ""}`}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
			>
				{attachments.length > 0 && (
					<div className="sh-attach-strip" aria-label="Attached images">
						{attachments.map(item => (
							<div key={item.id} className="sh-attach-thumb-wrap">
								<button
									type="button"
									className="sh-attach-thumb-btn"
									onClick={() => onPreviewImage?.(item.previewUrl)}
									title={`Preview ${item.name}`}
									aria-label={`Preview ${item.name}`}
								>
									<img src={item.previewUrl} alt={item.name} className="sh-attach-thumb" />
								</button>
								<button
									type="button"
									className="sh-attach-remove"
									onClick={() => setAttachments(prev => prev.filter(a => a.id !== item.id))}
									title="Remove image"
									aria-label={`Remove ${item.name}`}
								>
									<X size={10} aria-hidden />
								</button>
							</div>
						))}
					</div>
				)}
				{attachError && (
					<div className="sh-attach-error" role="status">
						<span>{attachError}</span>
						<button
							type="button"
							className="sh-attach-error-close"
							onClick={() => setAttachError(null)}
							aria-label="Dismiss attachment warning"
						>
							<X size={12} aria-hidden />
						</button>
					</div>
				)}
				<div className="sh-composer-row">
					<input
						ref={fileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						multiple
						hidden
						onChange={onFileChange}
					/>
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-attach-trigger"
						onClick={() => fileInputRef.current?.click()}
						disabled={!canPrompt || attachments.length >= MAX_IMAGES}
						title="Attach or paste image"
						aria-label="Attach image"
					>
						<ImagePlus size={15} aria-hidden />
					</button>
					<textarea
						ref={taRef}
						className="sh-composer-input"
						value={text}
						onChange={e => {
							historyIdxRef.current = -1;
							setText(e.target.value);
						}}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={onCompositionEnd}
						placeholder={
							live
								? busy
									? "Queue a follow-up…"
									: "Prompt the host agent… (press /)"
								: "Waiting for the session…"
						}
						disabled={!canPrompt}
						rows={1}
						spellCheck={false}
					/>
					<div className="sh-composer-actions">
						{busy && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={triggerAbort}
								disabled={!live || isStopping}
								title="stop the current turn"
							>
								<Square size={11} aria-hidden />{" "}
								<span className="sh-btn-label">{isStopping ? "Stopping…" : "Stop"}</span>
							</button>
						)}
						{busy && canSend && (
							<button
								type="button"
								className="sh-btn sh-btn-steer"
								onClick={() => commitPrompt(false)}
								title="Steer active turn immediately (Ctrl+Enter)"
							>
								<CornerDownRight size={13} aria-hidden />
								<span className="sh-btn-label">Steer</span>
							</button>
						)}
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => commitPrompt(busy)}
							disabled={!canSend}
							title={busy ? "Queue after active turn (Enter)" : "Send (Enter)"}
						>
							<SendHorizontal size={13} aria-hidden />{" "}
							<span className="sh-btn-label">{busy ? "Queue" : "Send"}</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
});
