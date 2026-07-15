/**
 * A `length` (output-token-limit) stop that happens because the input context is full
 * must be treated as a context overflow: the tool loop should stop immediately (no
 * staggering on truncated tool calls), compaction should run, and the agent should
 * auto-continue against the compacted context — bounded to one recovery attempt.
 *
 * Exercises both halves of the fix:
 *  - isContextOverflow returns true for such a length stop (packages/ai).
 *  - AgentSession.shouldStopAfterTurn bails the loop, and the overflow branch of
 *    _checkCompaction compacts + retries.
 */

import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

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

function contextText(context: Context): string {
	return context.messages
		.map((m) => {
			const c = (m as { content?: unknown }).content;
			if (typeof c === "string") return c;
			if (Array.isArray(c)) {
				return c
					.map((p) =>
						p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : "",
					)
					.join(" ");
			}
			return "";
		})
		.join("\n");
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

describe("compaction: length-stop under input pressure compacts and auto-continues", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stops the loop, compacts, and retries once against the compacted context", async () => {
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
			// Guard: without shouldStopAfterTurn the loop would spin on the truncated tool
			// call (the response always carries a tool call). Fail fast instead of hanging.
			if (calls > 6) throw new Error(`staggering not bounded: streamFn called ${calls} times`);
			contexts.push(context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				let message: AssistantMessage;
				let reason: "length" | "stop";
				if (!overflowMode) {
					// Warm-up turn: a normal completed turn with real token weight, so there is
					// prior history for compaction to summarize (keepRecentTokens keeps the lighter
					// overflow turn and cuts at this turn's boundary).
					message = {
						...fauxAssistantMessage(`warm-up done ${"x".repeat(4000)}`, { stopReason: "stop" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ input: 50, totalTokens: 50 }),
					};
					reason = "stop";
				} else {
					// Truncated by the output limit while the input context is full: a bash tool
					// call cut off before its arguments, input+cacheRead over the overflow
					// threshold (WINDOW - 4096 = 5904).
					message = {
						...fauxAssistantMessage([fauxToolCall("bash", {}, { id: `b${calls}` })], { stopReason: "length" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ input: 6000, output: 1, totalTokens: 6001 }),
					};
					reason = "length";
				}
				stream.push({ type: "done", reason, message });
			});
			return stream;
		};

		await harness.session.prompt("WARMUP establish some history");
		overflowMode = true;
		const callsBeforeOverflow = calls; // 1

		await harness.session.prompt("continue the tool-heavy task");

		// Compaction ran exactly once (overflow recovery is bounded to a single attempt).
		const compactions = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions.length).toBe(1);

		// The overflow prompt did not stagger: one length turn, one retry, then recovery
		// is exhausted and it stops. Two stream calls, not a spin.
		expect(calls - callsBeforeOverflow).toBe(2);

		// The retry ran against the compacted context.
		const retryContext = contexts[contexts.length - 1];
		expect(contextText(retryContext)).toContain("COMPACTED_SUMMARY");
	});
});
