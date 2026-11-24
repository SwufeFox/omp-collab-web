import { CheckCircle2, ClipboardPaste, Lock, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { parseCollabLink } from "../../lib/link";
import { OmpMark } from "./OmpMark";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

export function ConnectScreen({ defaultName, error, onConnect }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);

	const parsedPreview = useMemo(() => {
		const trimmed = link.trim();
		if (!trimmed) return null;
		const parsed = parseCollabLink(trimmed);
		if ("error" in parsed) return null;
		try {
			return {
				host: new URL(parsed.wsUrl).host,
				mode: parsed.writeToken ? "Interactive" : "Read-only",
			};
		} catch {
			return null;
		}
	}, [link]);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError("Paste a join link first.");
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || "guest");
	};

	const pasteLink = async (): Promise<void> => {
		try {
			const text = await navigator.clipboard.readText();
			if (text.trim()) {
				setLink(text.trim());
				setLocalError(null);
			}
		} catch {
			// Clipboard read permission denied or unsupported — silent fallback
		}
	};

	const shown = localError ?? error;

	return (
		<div className="sh-connect">
			<header className="sh-connect-top">
				<div className="sh-brand">
					<OmpMark />
					<span>omp</span>
					<span className="sh-brand-slash">/</span>
					<span className="sh-brand-app">collab</span>
				</div>
				<ThemeToggle />
			</header>
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<h1 className="sh-connect-title">Join a live session</h1>
					<p className="sh-connect-sub">
						Watch a live agent transcript, inspect tool runs, and send prompts directly from your browser.
					</p>
				</div>
				<div className="sh-field">
					<label className="sh-field-label" htmlFor="collab-link-input">
						Session link
					</label>
					<div className="sh-input-group">
						<input
							id="collab-link-input"
							className="sh-input sh-input-mono sh-input-in-group"
							type="text"
							value={link}
							onChange={e => {
								setLink(e.target.value);
								if (localError) setLocalError(null);
							}}
							placeholder="Paste your /collab link…"
							spellCheck={false}
							autoComplete="off"
							autoFocus
						/>
						{link.length > 0 && (
							<button
								type="button"
								className="sh-clear-btn"
								onClick={() => {
									setLink("");
									setLocalError(null);
								}}
								title="Clear"
								aria-label="Clear session link"
							>
								<X size={13} aria-hidden />
							</button>
						)}
						<button
							type="button"
							className="sh-paste-btn"
							onClick={() => void pasteLink()}
							title="Paste from clipboard"
							aria-label="Paste session link from clipboard"
						>
							<ClipboardPaste size={14} aria-hidden />
							<span>Paste</span>
						</button>
					</div>
					{parsedPreview ? (
						<span className="sh-field-hint sh-link-valid">
							<CheckCircle2 size={13} aria-hidden />
							<span>
								Ready · {parsedPreview.host} · {parsedPreview.mode}
							</span>
						</span>
					) : (
						<span className="sh-field-hint">
							Run <code>/collab</code> in omp to copy a session link.
						</span>
					)}
				</div>
				<div className="sh-name-row">
					<label className="sh-name-label" htmlFor="collab-name-input">
						Join as
					</label>
					<input
						id="collab-name-input"
						className="sh-input sh-name-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="guest"
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</div>
				{shown && (
					<div className="sh-connect-error" role="alert">
						{shown}
					</div>
				)}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					Join session
				</button>
				<div className="sh-connect-foot">
					<Lock size={13} aria-hidden />
					<span>End-to-end encrypted. Room keys stay in your browser link.</span>
				</div>
			</form>
		</div>
	);
}
