/**
 * Regression: a `length` (output-limit) stop under input pressure whose final
 * assistant message is TEXT (not a tool call) must still recover cleanly.
 *
 * The sibling test agent-session-compaction-length-overflow.test.ts covers the
 * same overflow path when the truncated message carries a tool call, and passes.
 * The field failure happened with a plain TEXT response (the model was writing an
 * answer about a large file it had just read and ran out of output budget while
 * the input context was full).
 *
 * Mechanism: overflow recovery compacts with willRetry=true and the post-run loop
 * calls agent.continue(). Because the rebuilt transcript still ends in the
 * `length` assistant message — the willRetry re-trim in _doRunAutoCompaction only
 * removes a trailing assistant when its stopReason is "error" — continue() throws
 * "Cannot continue from message role: assistant". When the run was kicked off by
 * an extension's fire-and-forget sendUserMessage, that surfaces as
 * `Extension "<runtime>" error`.
 */

import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

function usage(overrides: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

const WINDOW = 10000; // > CONTEXT_SAFETY_TOKENS (4096) so the overflow threshold is meaningful

const SUMMARY_PROVIDER: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", async (event) => ({
		compaction: {
			summary: "COMPACTED_SUMMARY",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: {},
		},
	}));
};

describe("compaction: length-stop TEXT response under input pressure recovers without continue() throwing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts and retries instead of throwing 'Cannot continue from message role: assistant'", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: WINDOW, maxTokens: 200 }],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 200 } },
			extensionFactories: [SUMMARY_PROVIDER],
		});
		harnesses.push(harness);

		const contexts: Context[] = [];
		let calls = 0;
		let overflowMode = false;
		harness.session.agent.streamFunction = (model, context) => {
			calls++;
			if (calls > 6) throw new Error(`staggering not bounded: streamFn called ${calls} times`);
			contexts.push(context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				let message: AssistantMessage;
				let reason: "length" | "stop";
				const base = { api: model.api, provider: model.provider, model: model.id };
				if (!overflowMode) {
					// Warm-up turn: a completed turn with real token weight, so there is prior
					// history for compaction to summarize.
					message = {
						...fauxAssistantMessage(`warm-up done ${"x".repeat(4000)}`, { stopReason: "stop" }),
						...base,
						usage: usage({ input: 50, totalTokens: 50 }),
					};
					reason = "stop";
				} else if (overflowMode && calls <= 2) {
					// A TEXT response truncated by the output limit while the input context is
					// full: stopReason "length", input+cacheRead over the overflow threshold
					// (WINDOW - 4096 = 5904). No tool call — the transcript tail is a text
					// assistant message.
					message = {
						...fauxAssistantMessage(`Here are the last entries ${"y".repeat(50)}`, { stopReason: "length" }),
						...base,
						usage: usage({ input: 6000, output: 1, totalTokens: 6001 }),
					};
					reason = "length";
				} else {
					// Recovery turn against the compacted context.
					message = {
						...fauxAssistantMessage("recovered summary of payments", { stopReason: "stop" }),
						...base,
						usage: usage({ input: 200, totalTokens: 200 }),
					};
					reason = "stop";
				}
				stream.push({ type: "done", reason, message });
			});
			return stream;
		};

		await harness.session.prompt("WARMUP establish some history");
		overflowMode = true;

		// This is the run that overflows. It must not throw / reject.
		await expect(harness.session.prompt("read payments.csv and tell me the last entries")).resolves.toBeUndefined();

		// Compaction ran (overflow recovery, bounded to a single attempt).
		const compactions = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions.length).toBe(1);

		// The retry ran against the compacted context.
		const retryContext = contexts[contexts.length - 1];
		const retryText = retryContext.messages
			.flatMap((m) => {
				const c = (m as { content?: unknown }).content;
				return Array.isArray(c)
					? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text) : ""))
					: [typeof c === "string" ? c : ""];
			})
			.join("\n");
		expect(retryText).toContain("COMPACTED_SUMMARY");
	});
});
