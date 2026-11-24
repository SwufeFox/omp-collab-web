import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestClient } from "../src/lib/client";
import type { ComposerProps } from "../src/components/shell/Composer";
import { Composer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function props(uiRequest: ComposerProps["uiRequest"]): ComposerProps {
	return { client, phase: "live", readOnly: false, uiRequest, working: true, queuedMessageCount: 0 };
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...props({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});

	it("surfaces approval badge and helpText on permission select requests", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...props({
					reqId: 4,
					kind: "select",
					title: "Allow bash rm -rf build/?",
					helpText: "Host agent requested destructive command execution.",
					approval: true,
					options: ["Allow once", "Deny"],
				})}
			/>,
		);

		expect(html).toContain("Approval required");
		expect(html).toContain("Host agent requested destructive command execution.");
		expect(html).toContain("sh-ask-card-approval");
	});

	it("renders attach trigger and docked queue shelf with item preview & deliver action while working", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				phase="live"
				readOnly={false}
				uiRequest={null}
				working={true}
				queuedMessageCount={2}
				queuedPrompts={[
					{
						id: "q1",
						text: "verify reconnect backoff",
						images: [],
						mode: "queued",
						createdAt: 1,
						baseEntryCount: 5,
					},
				]}
			/>,
		);

		expect(html).toContain('aria-label="Attach image"');
		expect(html).toContain("sh-queue-shelf");
		expect(html).toContain("×2");
		expect(html).toContain("verify reconnect backoff");
		expect(html).toContain("+1 queued by other participants");
		expect(html).toContain("Deliver now");
		expect(html).toContain("Queue");
	});

	it("renders the slash command palette when typing / in live composer", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				phase="live"
				readOnly={false}
				uiRequest={null}
				working={false}
				queuedMessageCount={0}
				initialText="/con"
			/>,
		);

		expect(html).toContain("sh-slash-menu");
		expect(html).toContain("/continue");
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});
