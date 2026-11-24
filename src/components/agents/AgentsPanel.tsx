import type {
	AgentProgress,
	AgentSnapshot,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens, relTime } from "../../lib/format";
import "./agents.css";

/** Re-render tick so running-tool durations and relative times stay live. */
function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

/**
 * Best-effort start timestamp for the in-flight tool. The host serializes the
 * full AgentProgress (which carries `currentToolStartMs`); the wire mirror
 * omits it, so read it tolerantly and fall back to the last tool's end time.
 */
function toolStartMs(p: AgentProgress): number | null {
	const start = (p as { currentToolStartMs?: unknown }).currentToolStartMs;
	if (typeof start === "number") return start;
	const lastEnd = p.recentTools[0]?.endMs;
	return typeof lastEnd === "number" ? lastEnd : null;
}

function activityLine(
	agent: AgentSnapshot,
	p: AgentProgress | undefined,
	lc: SubagentLifecyclePayload | undefined,
	now: number,
): string {
	if (p?.currentTool) {
		const start = toolStartMs(p);
		if (start !== null) return `${p.currentTool} · ${fmtDuration(Math.max(0, now - start))}`;
		return p.currentTool;
	}
	if (p?.lastIntent) return p.lastIntent;
	if (lc) return lc.status;
	return agent.status;
}

const AgentRow = memo(function AgentRow(props: {
	agent: AgentSnapshot;
	payload: SubagentProgressPayload | undefined;
	lifecycle: SubagentLifecyclePayload | undefined;
	selected: boolean;
	now: number;
	onSelect(id: string | null): void;
}): ReactNode {
	const { agent, payload, lifecycle, selected, now, onSelect } = props;
	const p = payload?.progress;
	return (
		<button
			type="button"
			className={selected ? "ag-row ag-row--selected" : "ag-row"}
			aria-pressed={selected}
			onClick={() => onSelect(selected ? null : agent.id)}
		>
			<span className="ag-row-head">
				<span className={`ag-dot ag-dot--${agent.status}`} />
				<span className="ag-row-name">{agent.displayName}</span>
				<ChevronRight size={13} className="ag-row-chev" aria-hidden />
			</span>
			<span className="ag-row-activity">{activityLine(agent, p, lifecycle, now)}</span>
			<span className="ag-row-meta">
				{p ? <span>{fmtTokens(p.tokens)} tok</span> : null}
				{p ? <span>{fmtCost(p.cost)}</span> : null}
				<span className="ag-row-meta-when">{relTime(agent.lastActivity)}</span>
			</span>
		</button>
	);
});

/** Memoized: the client replaces `progress`/`lifecycle` only when they change. */
export const AgentsPanel = memo(function AgentsPanel(props: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	selectedId: string | null;
	onSelect(id: string | null): void;
	onClose?(): void;
}): ReactNode {
	const { agents, progress, lifecycle, selectedId, onSelect, onClose } = props;
	const now = useNow(1000);

	const sorted = useMemo(() => {
		const mains: AgentSnapshot[] = [];
		const subs: AgentSnapshot[] = [];
		for (const agent of agents) (agent.kind === "main" ? mains : subs).push(agent);
		subs.sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			if (ar !== br) return ar - br;
			// Keep running subagents in spawn order so live progress updates never swap rows mid-tap on mobile.
			if (ar === 0) {
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				return a.id.localeCompare(b.id);
			}
			return b.lastActivity - a.lastActivity;
		});
		return { mains, subs };
	}, [agents]);

	return (
		<div className="ag-panel">
			{onClose && (
				<div className="ag-rail-head">
					<span className="ag-rail-title">Agents</span>
					<button type="button" className="ag-iconbtn" aria-label="Close agents panel" onClick={onClose}>
						<X size={16} aria-hidden />
					</button>
				</div>
			)}
			<div className="ag-heading">Session</div>
			{sorted.mains.map(agent => (
				<AgentRow
					key={agent.id}
					agent={agent}
					payload={progress.get(agent.id)}
					lifecycle={lifecycle.get(agent.id)}
					selected={selectedId === agent.id}
					now={now}
					onSelect={onSelect}
				/>
			))}
			<div className="ag-heading">
				Subagents
				{sorted.subs.length > 0 && <span className="ag-heading-count">{sorted.subs.length}</span>}
			</div>
			{sorted.subs.map(agent => (
				<AgentRow
					key={agent.id}
					agent={agent}
					payload={progress.get(agent.id)}
					lifecycle={lifecycle.get(agent.id)}
					selected={selectedId === agent.id}
					now={now}
					onSelect={onSelect}
				/>
			))}
			{sorted.subs.length === 0 ? <div className="ag-empty">No subagents yet</div> : null}
		</div>
	);
});
