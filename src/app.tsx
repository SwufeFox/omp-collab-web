import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer, type ComposerSlashUiAction } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { ImageLightbox } from "./components/shell/ImageLightbox";
import { Toasts } from "./components/shell/Toasts";
import { Transcript, type TranscriptViewMode } from "./components/transcript/Transcript";
import { GuestClient, type Notice } from "./lib/client";
import { extractCollabLink } from "./lib/link";
import {
	dropQueuedPrompts,
	type PendingPrompt,
	promoteQueuedToSending,
	reconcilePendingPrompts,
} from "./lib/prompt-queue";
import { setThemePreference, type ThemePreference, useThemePreference } from "./lib/theme";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
const VIEW_MODE_KEY = "omp.collab.viewMode";
const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

function storedViewMode(): TranscriptViewMode {
	try {
		const raw = localStorage.getItem(VIEW_MODE_KEY);
		if (raw === "focus" || raw === "standard" || raw === "detailed") return raw;
	} catch {
		// storage unavailable
	}
	return "standard";
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return extractCollabLink(href.slice(i + 1)) || null;
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);

	const connect = useCallback((link: string, name: string): void => {
		const cleaned = extractCollabLink(link);
		let next: GuestClient;
		try {
			next = new GuestClient(cleaned, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link: cleaned, name };
		if (hashLink() !== cleaned) {
			window.location.hash = cleaned;
		}
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		credsRef.current = null;
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: auto-connect on initial hash and on URL hash changes.
	useEffect(() => {
		const syncHash = (): void => {
			const link = hashLink();
			if (link && link !== credsRef.current?.link) {
				connect(link, storedName());
			}
		};
		syncHash();
		window.addEventListener("hashchange", syncHash);
		return () => window.removeEventListener("hashchange", syncHash);
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	if (!client) {
		return <ConnectScreen defaultName={storedName()} error={connectError} onConnect={connect} />;
	}
	return (
		<Session
			client={client}
			guestName={credsRef.current?.name ?? storedName()}
			draftKey={`omp.collab.draft:${credsRef.current?.link.slice(0, 24) ?? "default"}`}
			onLeave={leave}
			onRejoin={rejoin}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	guestName: string;
	draftKey: string;
	onLeave(): void;
	onRejoin(): void;
}

function Session({ client, guestName, draftKey, onLeave, onRejoin }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const { preference } = useThemePreference();
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [previewSrc, setPreviewSrc] = useState<string | null>(null);
	const [rawPendingPrompts, setRawPendingPrompts] = useState<readonly PendingPrompt[]>([]);
	const [localNotices, setLocalNotices] = useState<readonly Notice[]>([]);
	const [sendSeq, setSendSeq] = useState(0);
	const [viewState, setViewState] = useState<{ mode: TranscriptViewMode; seq: number }>(() => ({
		mode: storedViewMode(),
		seq: 0,
	}));
	const autoOpenedRef = useRef(false);
	const pendingIdSeqRef = useRef(0);
	const localNoticeIdRef = useRef(-1);
	const entriesLenRef = useRef(snap.entries.length);
	entriesLenRef.current = snap.entries.length;

	const pushLocalNotice = useCallback((level: "info" | "warning", message: string) => {
		setLocalNotices(prev => [
			...prev.slice(-9),
			{ id: localNoticeIdRef.current--, level, message, at: Date.now() },
		]);
	}, []);

	// Reconcile synchronously during render so confirmed entries never flash twice even for a single frame.
	const pendingPrompts = useMemo(
		() => reconcilePendingPrompts(rawPendingPrompts, snap.entries, guestName),
		[rawPendingPrompts, snap.entries, guestName],
	);

	useEffect(() => {
		if (pendingPrompts !== rawPendingPrompts) {
			setRawPendingPrompts(pendingPrompts);
		}
	}, [pendingPrompts, rawPendingPrompts]);

	// Clear pending ghosts if the session terminates.
	useEffect(() => {
		if (snap.phase === "ended" && rawPendingPrompts.length > 0) {
			setRawPendingPrompts([]);
		}
	}, [snap.phase, rawPendingPrompts.length]);

	// When the host finishes a turn and drains its queue (`!working && queuedMessageCount === 0`),
	// promote any remaining local queued items to `sending` so they transition smoothly.
	const hostQueuedCount = snap.state?.queuedMessageCount ?? 0;
	useEffect(() => {
		if (!snap.working && hostQueuedCount === 0 && rawPendingPrompts.some(p => p.mode === "queued")) {
			setRawPendingPrompts(prev => promoteQueuedToSending(prev));
		}
	}, [snap.working, hostQueuedCount, rawPendingPrompts]);

	const sendingPrompts = useMemo(
		() => pendingPrompts.filter(p => p.mode === "sending"),
		[pendingPrompts],
	);
	const queuedPrompts = useMemo(
		() => pendingPrompts.filter(p => p.mode === "queued"),
		[pendingPrompts],
	);

	const dispatchPrompt = useCallback(
		({ text, images, followUp }: { text: string; images: readonly ImageContent[]; followUp: boolean }) => {
			const id = `opt-${++pendingIdSeqRef.current}`;
			const nextItem: PendingPrompt = {
				id,
				text,
				images,
				mode: followUp ? "queued" : "sending",
				createdAt: Date.now(),
				baseEntryCount: entriesLenRef.current,
			};
			setRawPendingPrompts(prev => [...prev, nextItem]);
			if (!followUp) {
				setSendSeq(s => s + 1);
			}
			client.sendPrompt(text, images.length > 0 ? images : undefined, followUp ? { followUp: true } : undefined);
		},
		[client],
	);

	const deliverQueue = useCallback(() => {
		setRawPendingPrompts(prev => promoteQueuedToSending(prev));
		setSendSeq(s => s + 1);
		client.sendDeliverQueue();
	}, [client]);

	const abortRun = useCallback(() => {
		setRawPendingPrompts(prev => dropQueuedPrompts(prev));
		client.sendAbort();
	}, [client]);

	const resumeHost = useCallback(() => {
		client.sendResume();
		pushLocalNotice("info", "Sent resume to host session.");
	}, [client, pushLocalNotice]);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);
	const hostName = useMemo(
		() => snap.state?.participants.find(p => p.role === "host")?.name,
		[snap.state?.participants],
	);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail on wide screens the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			if (window.innerWidth > 960) {
				setRailOpen(true);
			}
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeRail = useCallback(() => setRailOpen(false), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);
	const openPreview = useCallback((src: string) => setPreviewSrc(src), []);
	const closePreview = useCallback(() => setPreviewSrc(null), []);
	const changeViewMode = useCallback((mode: TranscriptViewMode) => {
		setViewState(prev => ({ mode, seq: prev.seq + 1 }));
		try {
			localStorage.setItem(VIEW_MODE_KEY, mode);
		} catch {
			// storage unavailable
		}
	}, []);

	const handleSlashAction = useCallback(
		(action: ComposerSlashUiAction) => {
			switch (action.kind) {
				case "agents":
					setRailOpen(open => !open);
					break;
				case "view":
					changeViewMode(action.mode);
					pushLocalNotice("info", `Detail level: ${action.mode}`);
					break;
				case "theme": {
					const next = NEXT_THEME[preference];
					setThemePreference(next);
					pushLocalNotice("info", `Theme: ${next}`);
					break;
				}
				case "copy-link":
					void navigator.clipboard
						?.writeText(window.location.href)
						.then(() => pushLocalNotice("info", "Invite link copied to clipboard."))
						.catch(() => pushLocalNotice("warning", "Clipboard access unavailable."));
					break;
				case "leave":
					onLeave();
					break;
			}
		},
		[changeViewMode, onLeave, preference, pushLocalNotice],
	);

	const mergedNotices = useMemo(
		() => (localNotices.length === 0 ? snap.notices : [...snap.notices, ...localNotices]),
		[localNotices, snap.notices],
	);

	// Global session shortcuts: Alt+1/2/3 view modes, Alt+A or Ctrl/Cmd+\ agents panel, Esc mobile rail.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
				if (e.key === "1") {
					e.preventDefault();
					changeViewMode("focus");
					return;
				}
				if (e.key === "2") {
					e.preventDefault();
					changeViewMode("standard");
					return;
				}
				if (e.key === "3") {
					e.preventDefault();
					changeViewMode("detailed");
					return;
				}
				if (e.key === "a" || e.key === "A") {
					e.preventDefault();
					setRailOpen(open => !open);
					return;
				}
			}
			if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === "\\") {
				e.preventDefault();
				setRailOpen(open => !open);
				return;
			}
			if (e.key === "Escape" && railOpen && !drawerAgent && !previewSrc && window.innerWidth <= 960) {
				const active = document.activeElement as HTMLElement | null;
				if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
				setRailOpen(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [changeViewMode, drawerAgent, previewSrc, railOpen]);

	return (
		<div className="sh-app">
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				viewMode={viewState.mode}
				onChangeViewMode={changeViewMode}
				onToggleRail={toggleRail}
				onLeave={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							viewMode={viewState.mode}
							viewSeq={viewState.seq}
							guestName={guestName}
							hostName={hostName}
							host={toolHost}
							phase={snap.phase}
							sendingPrompts={sendingPrompts}
							sendSeq={sendSeq}
							onPreviewImage={openPreview}
						/>
					</div>
					<Composer
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						aborting={snap.state?.isAborting ?? false}
						queuedMessageCount={hostQueuedCount}
						queuedPrompts={queuedPrompts}
						draftKey={draftKey}
						onDispatchPrompt={dispatchPrompt}
						onDeliverQueue={deliverQueue}
						onAbortTriggered={abortRun}
						onResumeHost={resumeHost}
						onSlashAction={handleSlashAction}
						onLocalNotice={pushLocalNotice}
						onPreviewImage={openPreview}
					/>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={closeRail} />
						<aside className="sh-rail" aria-label="Session agents">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
								onClose={closeRail}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						viewMode={viewState.mode}
						viewSeq={viewState.seq}
						host={toolHost}
						onPreviewImage={openPreview}
						onClose={closeDrawer}
					/>
				</>
			)}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
			<Toasts notices={mergedNotices} />
			<ImageLightbox src={previewSrc} onClose={closePreview} />
		</div>
	);
}
