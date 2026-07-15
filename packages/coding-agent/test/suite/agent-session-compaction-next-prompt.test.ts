/**
 * Characterization tests: after a compaction, the NEXT prompt (or drained follow-up)
 * must be sent against the COMPACTED context, never the stale pre-compaction transcript.
 *
 * Motivation: a real llama.cpp session produced a wasted turn after compaction — the
 * request went out with the full pre-compaction context, so `clampMaxTokensToContext`
 * crushed the output budget to `MIN_MAX_TOKENS` (1) and the model emitted a single token
 * before a `length` stop. These tests pin the invariant across the scenarios that differ
 * from a trivial turn: a tool-call loop, a follow-up queued mid-compaction, and the real
 * LLM-summary path. They all currently PASS — the desync from the live report is not
 * reproducible through the AgentSession path, which is what makes them a useful guard.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

describe("compaction: next prompt uses the compacted context", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("sequential prompt after a threshold compaction drops the pre-compaction bulk", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: 1000, maxTokens: 200 }],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [SUMMARY_PROVIDER],
		});
		harnesses.push(harness);

		const sent: Context[] = [];
		let call = 0;
		harness.session.agent.streamFunction = (model, context) => {
			sent.push(context);
			call++;
			const first = call === 1;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(first ? "done" : "proceeding", { stopReason: "stop" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: first ? usage({ input: 500, totalTokens: 5000 }) : usage({ input: 50, totalTokens: 50 }),
					},
				});
			});
			return stream;
		};

		await harness.session.prompt("BULK_MARKER first request with content to compact");
		expect(harness.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
		await harness.session.prompt("Proceed.");

		const text = contextText(sent[sent.length - 1]);
		expect(text).toContain("Proceed.");
		expect(text).not.toContain("BULK_MARKER");
		expect(text).toContain("COMPACTED_SUMMARY");
	});

	it("prompt after compaction of a tool-call loop drops the bulky tool results", async () => {
		const bulk = `BULK_TOOL_RESULT ${"z".repeat(4000)}`;
		const genTool: AgentTool = {
			name: "gen",
			label: "gen",
			description: "Generate bulky output",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: bulk }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: 1000, maxTokens: 200 }],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 1 } },
			tools: [genTool],
			extensionFactories: [SUMMARY_PROVIDER],
		});
		harnesses.push(harness);

		const sent: Context[] = [];
		let call = 0;
		harness.session.agent.streamFunction = (model, context) => {
			sent.push(context);
			call++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				let message: AssistantMessage;
				if (call <= 3) {
					message = {
						...fauxAssistantMessage([fauxToolCall("gen", {}, { id: `gen-${call}` })], { stopReason: "toolUse" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ input: 100 }),
					};
				} else if (call === 4) {
					message = {
						...fauxAssistantMessage("loop done", { stopReason: "stop" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ input: 500, totalTokens: 5000 }),
					};
				} else {
					message = {
						...fauxAssistantMessage("proceeding", { stopReason: "stop" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage({ input: 50, totalTokens: 50 }),
					};
				}
				stream.push({ type: "done", reason: call <= 3 ? "toolUse" : "stop", message });
			});
			return stream;
		};

		await harness.session.prompt("do the bulky work");
		expect(harness.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
		await harness.session.prompt("Proceed.");

		const text = contextText(sent[sent.length - 1]);
		expect(text).toContain("Proceed.");
		expect(text).not.toContain("BULK_TOOL_RESULT");
	});

	it("follow-up queued during a turn-end compaction runs against the compacted context", async () => {
		let releaseCompaction: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		let signalStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: 1000, maxTokens: 200 }],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						signalStarted();
						await gate;
						return {
							compaction: {
								summary: "COMPACTED_SUMMARY",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		const sent: Context[] = [];
		let call = 0;
		harness.session.agent.streamFunction = (model, context) => {
			sent.push(context);
			call++;
			const first = call === 1;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(first ? "first done" : "followup done", { stopReason: "stop" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: first ? usage({ input: 500, totalTokens: 5000 }) : usage({ input: 50, totalTokens: 50 }),
					},
				});
			});
			return stream;
		};

		const firstPrompt = harness.session.prompt("BULK_MARKER first request with content to compact");
		await started;
		expect(harness.session.isStreaming).toBe(true);
		const queued = harness.session.prompt("Proceed.", { streamingBehavior: "followUp" });
		releaseCompaction();
		await Promise.all([firstPrompt, queued]);

		const text = contextText(sent[sent.length - 1]);
		expect(text).toContain("Proceed.");
		expect(text).not.toContain("BULK_MARKER");
	});

	it("prompt after LLM-summary compaction uses the compacted context", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: 1000, maxTokens: 200 }],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);

		const mainContexts: Context[] = [];
		let mainCall = 0;
		harness.session.agent.streamFunction = (model, context) => {
			const isSummary = (context.systemPrompt ?? "").includes("context summarization assistant");
			const stream = createAssistantMessageEventStream();
			if (isSummary) {
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("COMPACTED_SUMMARY structured checkpoint"),
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: usage({ input: 10, totalTokens: 10 }),
						},
					});
				});
				return stream;
			}
			mainCall++;
			mainContexts.push(context);
			const first = mainCall === 1;
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(first ? "first done" : "followup done", { stopReason: "stop" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: first ? usage({ input: 500, totalTokens: 5000 }) : usage({ input: 50, totalTokens: 50 }),
					},
				});
			});
			return stream;
		};

		await harness.session.prompt("BULK_MARKER first request with content to compact");
		expect(harness.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
		await harness.session.prompt("Proceed.");

		const text = contextText(mainContexts[mainContexts.length - 1]);
		expect(text).toContain("Proceed.");
		expect(text).not.toContain("BULK_MARKER");
		expect(text).toContain("COMPACTED_SUMMARY");
	});
});
