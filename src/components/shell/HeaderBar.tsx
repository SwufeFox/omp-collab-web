import type { SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { Check, ChevronDown, Eye, Link2, LogOut, Monitor, Moon, MoreHorizontal, PanelRight, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useId, useRef, useState } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import type { TranscriptViewMode } from "../transcript/Transcript";
import { OmpMark } from "./OmpMark";
import { ThemeToggle } from "./ThemeToggle";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

const VIEW_MODES: readonly { id: TranscriptViewMode; label: string; hint: string }[] = [
	{ id: "focus", label: "Focus", hint: "Collapse settled step groups" },
	{ id: "standard", label: "Standard", hint: "Keep latest & errors open" },
	{ id: "detailed", label: "Detailed", hint: "Expand all steps & outputs" },
];

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const THEME_LABEL: Record<ThemePreference, string> = {
	system: "Theme: System",
	light: "Theme: Light",
	dark: "Theme: Dark",
};

const THEME_ICON = {
	system: Monitor,
	light: Sun,
	dark: Moon,
} as const;

export interface HeaderBarProps {
	header: SessionHeader | null;
	state: SessionState | null;
	phase: ConnectionPhase;
	readOnly: boolean;
	subCount: number;
	railOpen: boolean;
	viewMode: TranscriptViewMode;
	onChangeViewMode(mode: TranscriptViewMode): void;
	onToggleRail(): void;
	onLeave(): void;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	readOnly,
	subCount,
	railOpen,
	viewMode,
	onChangeViewMode,
	onToggleRail,
	onLeave,
}: HeaderBarProps): ReactNode {
	const [openMenu, setOpenMenu] = useState<"details" | "more" | null>(null);
	const [copied, setCopied] = useState(false);
	const detailsRef = useRef<HTMLDivElement | null>(null);
	const moreRef = useRef<HTMLDivElement | null>(null);
	const detailsId = useId();
	const moreId = useId();
	const { preference, setPreference } = useThemePreference();

	const title = header?.title ?? state?.sessionName ?? "session";
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	useEffect(() => {
		if (!openMenu) return;
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpenMenu(null);
		};
		const onPointerDown = (e: PointerEvent): void => {
			const target = e.target as Node;
			const anchor = openMenu === "details" ? detailsRef.current : moreRef.current;
			if (anchor && !anchor.contains(target)) {
				setOpenMenu(null);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("pointerdown", onPointerDown);
		};
	}, [openMenu]);

	useEffect(() => {
		if (railOpen) setOpenMenu(null);
	}, [railOpen]);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);

	const copyInvite = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(window.location.href);
			setCopied(true);
		} catch {
			// Clipboard write unavailable — non-fatal
		}
	};

	const clampedPct = pct != null ? Math.min(100, Math.max(0, pct)) : null;
	const ThemeIcon = THEME_ICON[preference];

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<span className="sh-brand" aria-label="omp collab">
					<OmpMark size={20} />
				</span>
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				<div className="sh-mode-group sh-desktop-only" role="group" aria-label="Detail level">
					{VIEW_MODES.map(m => (
						<button
							key={m.id}
							type="button"
							className={`sh-mode-btn${viewMode === m.id ? " sh-mode-btn-active" : ""}`}
							onClick={() => onChangeViewMode(m.id)}
							aria-pressed={viewMode === m.id}
							title={m.hint}
						>
							{m.label}
						</button>
					))}
				</div>

				<div className="sh-details-anchor" ref={detailsRef}>
					<button
						type="button"
						className={`sh-status sh-status-${phase}${openMenu === "details" ? " sh-status-open" : ""}`}
						onClick={() => setOpenMenu(cur => (cur === "details" ? null : "details"))}
						aria-expanded={openMenu === "details"}
						aria-controls={detailsId}
						title="Session details"
					>
						<span className={`sh-dot sh-dot-${phase}`} />
						<span className="sh-status-text">{PHASE_LABEL[phase]}</span>
						{clampedPct != null && (
							<span className={`sh-status-ctx${clampedPct > 80 ? " sh-status-ctx-warn" : ""}`}>
								{fmtPercent(clampedPct)}
							</span>
						)}
						<ChevronDown size={13} className="sh-status-chev" aria-hidden />
					</button>
					{openMenu === "details" && (
						<div id={detailsId} className="sh-popover" role="dialog" aria-label="Session details">
							<div className="sh-popover-row">
								<span className="sh-popover-label">Status</span>
								<span className="sh-popover-value">
									<span className={`sh-dot sh-dot-${phase}`} />
									<span>{PHASE_LABEL[phase]}</span>
									{readOnly && (
										<span className="sh-popover-badge">
											<Eye size={11} aria-hidden />
											Read-only
										</span>
									)}
								</span>
							</div>
							{state?.model && (
								<div className="sh-popover-row">
									<span className="sh-popover-label">Model</span>
									<span className="sh-popover-value sh-popover-mono">
										{state.model.name}
										{state.thinkingLevel ? ` · ${state.thinkingLevel}` : ""}
									</span>
								</div>
							)}
							{clampedPct != null && (
								<div className="sh-popover-block">
									<div className="sh-popover-row">
										<span className="sh-popover-label">Context</span>
										<span className={`sh-popover-mono${clampedPct > 80 ? " sh-popover-warn" : ""}`}>
											{fmtPercent(clampedPct)}
										</span>
									</div>
									<div className="sh-gauge-track sh-gauge-track-wide">
										<span
											className={`sh-gauge-fill${clampedPct > 80 ? " sh-gauge-fill-warn" : ""}`}
											style={{ width: `${clampedPct}%` }}
										/>
									</div>
								</div>
							)}
							{state?.cwd && (
								<div className="sh-popover-block">
									<span className="sh-popover-label">Workspace</span>
									<span className="sh-popover-path" title={state.cwd}>
										{state.cwd}
									</span>
								</div>
							)}
							{state && state.participants.length > 0 && (
								<div className="sh-popover-block">
									<span className="sh-popover-label">
										Participants ({state.participants.length})
									</span>
									<ul className="sh-participants-list">
										{state.participants.map((p, i) => (
											<li key={`${p.name}:${i}`} className="sh-participant">
												<span
													className={
														p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"
													}
													aria-hidden
												>
													{(p.name[0] ?? "?").toUpperCase()}
												</span>
												<span className="sh-participant-name">{p.name}</span>
												<span className="sh-participant-role">
													{p.role}
													{p.readOnly ? " · view-only" : ""}
												</span>
											</li>
										))}
									</ul>
								</div>
							)}
						</div>
					)}
				</div>

				<button
					type="button"
					className={`sh-btn sh-btn-icon sh-desktop-only${copied ? " sh-btn-copied" : ""}`}
					onClick={() => void copyInvite()}
					title={copied ? "Invite link copied" : "Copy invite link"}
					aria-label={copied ? "Copied" : "Copy invite link"}
				>
					{copied ? <Check size={15} aria-hidden /> : <Link2 size={15} aria-hidden />}
				</button>
				<div className="sh-desktop-only">
					<ThemeToggle />
				</div>
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "Hide agents" : "Show agents"}
					aria-label={railOpen ? "Hide agents panel" : "Show agents panel"}
					aria-pressed={railOpen}
				>
					<PanelRight size={15} aria-hidden />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-btn-leave sh-desktop-only"
					onClick={onLeave}
					title="Leave session"
					aria-label="Leave session"
				>
					<LogOut size={15} aria-hidden />
				</button>

				<div className="sh-more-anchor sh-mobile-only" ref={moreRef}>
					<button
						type="button"
						className={`sh-btn sh-btn-icon${openMenu === "more" ? " sh-btn-on" : ""}`}
						onClick={() => setOpenMenu(cur => (cur === "more" ? null : "more"))}
						aria-expanded={openMenu === "more"}
						aria-controls={moreId}
						aria-label="View options and session actions"
					>
						<MoreHorizontal size={16} aria-hidden />
					</button>
					{openMenu === "more" && (
						<div id={moreId} className="sh-popover sh-popover-menu" role="dialog" aria-label="View and actions">
							<div className="sh-popover-section-label">Detail level</div>
							<div className="sh-mode-group sh-mode-group-full" role="group" aria-label="Detail level">
								{VIEW_MODES.map(m => (
									<button
										key={m.id}
										type="button"
										className={`sh-mode-btn${viewMode === m.id ? " sh-mode-btn-active" : ""}`}
										onClick={() => onChangeViewMode(m.id)}
										aria-pressed={viewMode === m.id}
									>
										{m.label}
									</button>
								))}
							</div>
							<div className="sh-menu-sep" />
							<button
								type="button"
								className="sh-menu-item"
								onClick={() => {
									void copyInvite();
									setOpenMenu(null);
								}}
							>
								{copied ? <Check size={15} aria-hidden /> : <Link2 size={15} aria-hidden />}
								<span>{copied ? "Copied invite link" : "Copy invite link"}</span>
							</button>
							<button
								type="button"
								className="sh-menu-item"
								onClick={() => setPreference(NEXT_THEME[preference])}
							>
								<ThemeIcon size={15} aria-hidden />
								<span>{THEME_LABEL[preference]}</span>
							</button>
							<button
								type="button"
								className="sh-menu-item sh-menu-item-danger"
								onClick={() => {
									setOpenMenu(null);
									onLeave();
								}}
							>
								<LogOut size={15} aria-hidden />
								<span>Leave session</span>
							</button>
						</div>
					)}
				</div>
			</div>
		</header>
	);
});
