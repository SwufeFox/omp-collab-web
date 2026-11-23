import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	loading: GuestSnapshot["loading"];
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, loading, onRejoin, onNewLink }: BannersProps): ReactNode {
	const progress = loading && loading.total > 0 ? ` ${Math.floor((loading.received / loading.total) * 100)}%` : "";
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				<span>{phase === "connecting" ? "Connecting to relay…" : `Syncing session…${progress}`}</span>
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				<span>{`Reconnecting…${progress}`}</span>
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label="Session ended">
				<div className="sh-ended-card">
					<div className="sh-ended-title">Session ended</div>
					<div className="sh-ended-reason">{endedReason ?? "The host closed this session."}</div>
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							Rejoin
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							New link
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}
