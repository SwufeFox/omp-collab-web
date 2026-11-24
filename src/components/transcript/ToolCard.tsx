import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { memo } from "react";
import { messageText } from "../../lib/format";
import { type ToolRenderHost, ToolView } from "../../tool-render";
import type { ToolOpenSignal } from "../../tool-render/ToolView";

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	startedAt?: number;
	partialResult?: unknown;
	defaultOpen?: boolean;
	openSignal?: ToolOpenSignal;
	host?: ToolRenderHost;
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { name, intent, args, result, running, startedAt, partialResult, defaultOpen, openSignal, host } = props;
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	return (
		<ToolView
			name={name}
			args={args}
			result={result}
			running={running}
			startedAt={startedAt}
			intent={intent}
			partial={partial || undefined}
			defaultOpen={defaultOpen}
			openSignal={openSignal}
			host={host}
		/>
	);
});
