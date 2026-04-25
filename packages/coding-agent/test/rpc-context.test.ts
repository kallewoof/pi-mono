/**
 * Tests for multi-context support in RPC mode.
 *
 * Each named context gets its own isolated AgentSession. Commands without a
 * context field use the default session, preserving backward compatibility.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Allow many process-level listeners (one SIGTERM/SIGHUP/stdin "end" per runRpcMode call per test).
process.setMaxListeners(100);
process.stdin.setMaxListeners(100);

// ============================================================================
// Module-level mocks
// ============================================================================

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
	waitForRawStdoutBackpressure: async () => {},
	flushRawStdout: async () => {},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

// ============================================================================
// Mock stream helpers
// ============================================================================

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// ============================================================================
// Output parsing helpers
// ============================================================================

type ParsedLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedLine);
}

function getResponseById(outputLines: string[], id: string): ParsedLine | undefined {
	return parseOutputLines(outputLines).find((r) => r.id === id && r.type === "response");
}

function getResponseData(response: ParsedLine): ParsedLine {
	return (response.data ?? {}) as ParsedLine;
}

function waitForResponse(id: string): () => void {
	return () => {
		expect(getResponseById(rpcIo.outputLines, id)).toBeDefined();
	};
}

function waitForEvent(type: string, context?: string): () => void {
	return () => {
		const parsed = parseOutputLines(rpcIo.outputLines);
		const event = parsed.find((r) => r.type === type && (context === undefined ? true : r.context === context));
		expect(event).toBeDefined();
	};
}

// ============================================================================
// Runtime host factory
// ============================================================================

interface RuntimeHostOptions {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
}

interface RuntimeHostResult {
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}

function createRuntimeHostInDir(sessionsDir: string, options: RuntimeHostOptions): RuntimeHostResult {
	const tempDir = join(tmpdir(), `pi-rpc-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model not found");

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	function makeMockStream(): MockAssistantStream {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: createAssistantMessage("") });
			setTimeout(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("response") });
			}, options.responseDelayMs);
		});
		return stream;
	}

	function createMockAgent(): Agent {
		return new Agent({
			getApiKey: () => "test-key",
			initialState: { model: model!, systemPrompt: "Test", tools: [] },
			streamFn: () => makeMockStream(),
		});
	}

	// Main session uses the shared sessionsDir so contexts.json lands there.
	const mainSessionManager = SessionManager.create(tempDir, sessionsDir);
	const mainSession = new AgentSession({
		agent: createMockAgent(),
		sessionManager: mainSessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	const createdSessions: AgentSession[] = [];

	const runtimeHost = {
		session: mainSession,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		createIsolatedSession: vi.fn(async () => {
			const sm = SessionManager.create(tempDir, sessionsDir);
			const s = new AgentSession({
				agent: createMockAgent(),
				sessionManager: sm,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				resourceLoader: createTestResourceLoader(),
			});
			createdSessions.push(s);
			return s;
		}),
		loadIsolatedSession: vi.fn(async (sessionPath: string) => {
			const sm = SessionManager.open(sessionPath);
			const s = new AgentSession({
				agent: createMockAgent(),
				sessionManager: sm,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				resourceLoader: createTestResourceLoader(),
			});
			createdSessions.push(s);
			return s;
		}),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			for (const s of createdSessions) {
				try {
					s.dispose();
				} catch {
					// ignore
				}
			}
			try {
				if (mainSession.isStreaming) await mainSession.abort();
			} catch {
				// ignore
			}
			mainSession.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

async function startRpcModeInDir(
	sessionsDir: string,
	options: RuntimeHostOptions,
): Promise<{ lineHandler: (line: string) => void; cleanup: () => Promise<void> }> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = createRuntimeHostInDir(sessionsDir, options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
}

async function startRpcMode(
	options: RuntimeHostOptions,
): Promise<{ lineHandler: (line: string) => void; cleanup: () => Promise<void>; sessionsDir: string }> {
	const sessionsDir = join(tmpdir(), `pi-ctx-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const { lineHandler, cleanup } = await startRpcModeInDir(sessionsDir, options);
	return {
		lineHandler,
		cleanup: async () => {
			await cleanup();
			if (existsSync(sessionsDir)) rmSync(sessionsDir, { recursive: true });
		},
		sessionsDir,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("RPC multi-context", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	// --------------------------------------------------------------------------
	// Context field in responses
	// --------------------------------------------------------------------------

	it("get_state without context has no context field in response data", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "gs-noCtx", type: "get_state" }));
			await vi.waitFor(waitForResponse("gs-noCtx"));
			const resp = getResponseById(rpcIo.outputLines, "gs-noCtx")!;
			expect(getResponseData(resp).context).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	it("get_state with context echoes context name in response data", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "gs-ctx", type: "get_state", context: "FamilyChat" }));
			await vi.waitFor(waitForResponse("gs-ctx"));
			const resp = getResponseById(rpcIo.outputLines, "gs-ctx")!;
			expect(getResponseData(resp).context).toBe("FamilyChat");
		} finally {
			await cleanup();
		}
	});

	it("prompt success response carries context name", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "pr-ctx", type: "prompt", message: "hi", context: "WorkChat" }));
			await vi.waitFor(() => {
				const parsed = parseOutputLines(rpcIo.outputLines);
				const resp = parsed.find((r) => r.id === "pr-ctx" && r.type === "response" && r.command === "prompt");
				expect(resp).toBeDefined();
				expect(resp!.context).toBe("WorkChat");
				expect(resp!.success).toBe(true);
			});
		} finally {
			await cleanup();
		}
	});

	it("prompt failure response carries context name", async () => {
		// withAuth: false → no API key stored → prompt preflight fails
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "pr-fail-ctx", type: "prompt", message: "hi", context: "ErrCtx" }));
			await vi.waitFor(() => {
				const parsed = parseOutputLines(rpcIo.outputLines);
				const resp = parsed.find((r) => r.id === "pr-fail-ctx" && r.type === "response" && r.command === "prompt");
				expect(resp).toBeDefined();
				expect(resp!.success).toBe(false);
				expect(resp!.context).toBe("ErrCtx");
			});
		} finally {
			await cleanup();
		}
	});

	it("prompt without context has no context field in response", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "pr-noCtx", type: "prompt", message: "hi" }));
			await vi.waitFor(() => {
				const parsed = parseOutputLines(rpcIo.outputLines);
				const resp = parsed.find((r) => r.id === "pr-noCtx" && r.type === "response" && r.command === "prompt");
				expect(resp).toBeDefined();
				expect(resp!.context).toBeUndefined();
			});
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// Event tagging
	// --------------------------------------------------------------------------

	it("events from context sessions carry context name", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "ev-ctx", type: "prompt", message: "hello", context: "Tagged" }));

			// Wait for prompt ACK first
			await vi.waitFor(() => {
				const parsed = parseOutputLines(rpcIo.outputLines);
				expect(parsed.find((r) => r.id === "ev-ctx" && r.command === "prompt")).toBeDefined();
			});

			// Then wait for agent_end event tagged with the context
			await vi.waitFor(waitForEvent("agent_end", "Tagged"));

			// All events from this run that have a context should be "Tagged"
			const eventsWithContext = parseOutputLines(rpcIo.outputLines).filter(
				(r) => r.type !== "response" && r.context !== undefined,
			);
			expect(eventsWithContext.length).toBeGreaterThan(0);
			for (const event of eventsWithContext) {
				expect(event.context).toBe("Tagged");
			}
		} finally {
			await cleanup();
		}
	});

	it("events from default session have no context field", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "ev-noCtx", type: "prompt", message: "hello" }));

			await vi.waitFor(() => {
				const parsed = parseOutputLines(rpcIo.outputLines);
				expect(parsed.find((r) => r.id === "ev-noCtx" && r.command === "prompt")).toBeDefined();
			});

			await vi.waitFor(waitForEvent("agent_end"));

			const sessionEvents = parseOutputLines(rpcIo.outputLines).filter((r) => r.type !== "response");
			expect(sessionEvents.length).toBeGreaterThan(0);
			for (const event of sessionEvents) {
				expect(event.context).toBeUndefined();
			}
		} finally {
			await cleanup();
		}
	});

	it("events from different context sessions are tagged with their respective context", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Fire prompts to two contexts back-to-back
			lineHandler(JSON.stringify({ id: "ev-A", type: "prompt", message: "hello A", context: "Alpha" }));
			lineHandler(JSON.stringify({ id: "ev-B", type: "prompt", message: "hello B", context: "Beta" }));

			// Wait for both agent_end events
			await vi.waitFor(waitForEvent("agent_end", "Alpha"));
			await vi.waitFor(waitForEvent("agent_end", "Beta"));

			// No events should have the wrong context label
			const allEvents = parseOutputLines(rpcIo.outputLines).filter((r) => r.type !== "response");
			const alphaEvents = allEvents.filter((r) => r.context === "Alpha");
			const betaEvents = allEvents.filter((r) => r.context === "Beta");
			expect(alphaEvents.length).toBeGreaterThan(0);
			expect(betaEvents.length).toBeGreaterThan(0);
			// No event should have a context that is neither Alpha nor Beta
			for (const e of allEvents) {
				if (e.context !== undefined) {
					expect(["Alpha", "Beta"]).toContain(e.context);
				}
			}
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// Session isolation
	// --------------------------------------------------------------------------

	it("two different context names get independent sessions with different session IDs", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "iso-A", type: "get_state", context: "CtxA" }));
			lineHandler(JSON.stringify({ id: "iso-B", type: "get_state", context: "CtxB" }));

			await vi.waitFor(() => {
				expect(getResponseById(rpcIo.outputLines, "iso-A")).toBeDefined();
				expect(getResponseById(rpcIo.outputLines, "iso-B")).toBeDefined();
			});

			const idA = getResponseData(getResponseById(rpcIo.outputLines, "iso-A")!).sessionId as string;
			const idB = getResponseData(getResponseById(rpcIo.outputLines, "iso-B")!).sessionId as string;
			expect(idA).toBeDefined();
			expect(idB).toBeDefined();
			expect(idA).not.toBe(idB);
		} finally {
			await cleanup();
		}
	});

	it("context session is also independent from the default session", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "iso-def", type: "get_state" }));
			lineHandler(JSON.stringify({ id: "iso-named", type: "get_state", context: "Named" }));

			await vi.waitFor(() => {
				expect(getResponseById(rpcIo.outputLines, "iso-def")).toBeDefined();
				expect(getResponseById(rpcIo.outputLines, "iso-named")).toBeDefined();
			});

			const defaultId = getResponseData(getResponseById(rpcIo.outputLines, "iso-def")!).sessionId as string;
			const namedId = getResponseData(getResponseById(rpcIo.outputLines, "iso-named")!).sessionId as string;
			expect(defaultId).not.toBe(namedId);
		} finally {
			await cleanup();
		}
	});

	it("same context name consistently reuses the same session", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "reuse-1", type: "get_state", context: "Reused" }));
			await vi.waitFor(waitForResponse("reuse-1"));
			const firstId = getResponseData(getResponseById(rpcIo.outputLines, "reuse-1")!).sessionId as string;

			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "reuse-2", type: "get_state", context: "Reused" }));
			await vi.waitFor(waitForResponse("reuse-2"));
			const secondId = getResponseData(getResponseById(rpcIo.outputLines, "reuse-2")!).sessionId as string;

			expect(firstId).toBe(secondId);
		} finally {
			await cleanup();
		}
	});

	it("three different contexts are all independent (different session IDs)", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			const contexts = ["work", "family", "personal"];
			for (const ctx of contexts) {
				lineHandler(JSON.stringify({ id: `multi-${ctx}`, type: "get_state", context: ctx }));
			}

			await vi.waitFor(() => {
				for (const ctx of contexts) {
					expect(getResponseById(rpcIo.outputLines, `multi-${ctx}`)).toBeDefined();
				}
			});

			const sessionIds = contexts.map(
				(ctx) => getResponseData(getResponseById(rpcIo.outputLines, `multi-${ctx}`)!).sessionId as string,
			);
			const uniqueIds = new Set(sessionIds);
			expect(uniqueIds.size).toBe(contexts.length);
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// Context session auto-naming
	// --------------------------------------------------------------------------

	it("context session is automatically named after the context string", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "name-ctx", type: "get_state", context: "FamilyGroup" }));
			await vi.waitFor(waitForResponse("name-ctx"));
			const data = getResponseData(getResponseById(rpcIo.outputLines, "name-ctx")!);
			expect(data.sessionName).toBe("FamilyGroup");
		} finally {
			await cleanup();
		}
	});

	it("default session is not auto-named by context creation", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Create a context session (which gets named "SomeCtx")
			lineHandler(JSON.stringify({ id: "name-def-ctx", type: "get_state", context: "SomeCtx" }));
			await vi.waitFor(waitForResponse("name-def-ctx"));

			// Default session should have no name
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "name-def", type: "get_state" }));
			await vi.waitFor(waitForResponse("name-def"));
			const data = getResponseData(getResponseById(rpcIo.outputLines, "name-def")!);
			expect(data.sessionName).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// new_session with context
	// --------------------------------------------------------------------------

	it("new_session with context replaces only that context's session", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Establish two contexts
			lineHandler(JSON.stringify({ id: "ns-A1", type: "get_state", context: "Replaced" }));
			lineHandler(JSON.stringify({ id: "ns-B1", type: "get_state", context: "Preserved" }));
			await vi.waitFor(() => {
				expect(getResponseById(rpcIo.outputLines, "ns-A1")).toBeDefined();
				expect(getResponseById(rpcIo.outputLines, "ns-B1")).toBeDefined();
			});

			const origA = getResponseData(getResponseById(rpcIo.outputLines, "ns-A1")!).sessionId as string;
			const origB = getResponseData(getResponseById(rpcIo.outputLines, "ns-B1")!).sessionId as string;

			// Reset context "Replaced"
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-new", type: "new_session", context: "Replaced" }));
			await vi.waitFor(waitForResponse("ns-new"));
			const newResp = getResponseById(rpcIo.outputLines, "ns-new")!;
			expect(newResp.success).toBe(true);
			expect((newResp.data as Record<string, unknown>).cancelled).toBe(false);

			// "Replaced" should have a new session ID
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-A2", type: "get_state", context: "Replaced" }));
			lineHandler(JSON.stringify({ id: "ns-B2", type: "get_state", context: "Preserved" }));
			await vi.waitFor(() => {
				expect(getResponseById(rpcIo.outputLines, "ns-A2")).toBeDefined();
				expect(getResponseById(rpcIo.outputLines, "ns-B2")).toBeDefined();
			});

			const newA = getResponseData(getResponseById(rpcIo.outputLines, "ns-A2")!).sessionId as string;
			const newB = getResponseData(getResponseById(rpcIo.outputLines, "ns-B2")!).sessionId as string;

			expect(newA).not.toBe(origA); // "Replaced" context has a new session
			expect(newB).toBe(origB); // "Preserved" context is unchanged
		} finally {
			await cleanup();
		}
	});

	it("new_session with context resets that context's message history", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Send a prompt to a context so it has messages
			lineHandler(JSON.stringify({ id: "ns-msg-prompt", type: "prompt", message: "hello", context: "MsgCtx" }));
			await vi.waitFor(waitForEvent("agent_end", "MsgCtx"));

			// Verify it has messages
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-msg-before", type: "get_state", context: "MsgCtx" }));
			await vi.waitFor(waitForResponse("ns-msg-before"));
			const beforeCount = getResponseData(getResponseById(rpcIo.outputLines, "ns-msg-before")!)
				.messageCount as number;
			expect(beforeCount).toBeGreaterThan(0);

			// Reset the context session
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-msg-reset", type: "new_session", context: "MsgCtx" }));
			await vi.waitFor(waitForResponse("ns-msg-reset"));

			// Fresh session should have zero messages
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-msg-after", type: "get_state", context: "MsgCtx" }));
			await vi.waitFor(waitForResponse("ns-msg-after"));
			const afterCount = getResponseData(getResponseById(rpcIo.outputLines, "ns-msg-after")!).messageCount as number;
			expect(afterCount).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("new_session without context does not affect named context sessions", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Create a context session
			lineHandler(JSON.stringify({ id: "ns-nc-init", type: "get_state", context: "Stable" }));
			await vi.waitFor(waitForResponse("ns-nc-init"));
			const stableId = getResponseData(getResponseById(rpcIo.outputLines, "ns-nc-init")!).sessionId as string;

			// new_session with no context (the mock returns cancelled:true for this)
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-nc-new", type: "new_session" }));
			await vi.waitFor(waitForResponse("ns-nc-new"));

			// The "Stable" context should still have the same session ID
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ns-nc-check", type: "get_state", context: "Stable" }));
			await vi.waitFor(waitForResponse("ns-nc-check"));
			const afterId = getResponseData(getResponseById(rpcIo.outputLines, "ns-nc-check")!).sessionId as string;
			expect(afterId).toBe(stableId);
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// Command routing to context sessions
	// --------------------------------------------------------------------------

	it("get_messages routes to context session and returns its messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Prompt context "MsgRoute" so it has messages
			lineHandler(JSON.stringify({ id: "gm-prompt", type: "prompt", message: "test msg", context: "MsgRoute" }));
			await vi.waitFor(waitForEvent("agent_end", "MsgRoute"));

			// get_messages for the context should have user + assistant
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "gm-ctx", type: "get_messages", context: "MsgRoute" }));
			await vi.waitFor(waitForResponse("gm-ctx"));
			const ctxMessages =
				(getResponseData(getResponseById(rpcIo.outputLines, "gm-ctx")!).messages as unknown[]) ?? [];
			expect(ctxMessages.length).toBeGreaterThanOrEqual(2);

			// get_messages for default session should be empty (no prompts sent there)
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "gm-def", type: "get_messages" }));
			await vi.waitFor(waitForResponse("gm-def"));
			const defMessages =
				(getResponseData(getResponseById(rpcIo.outputLines, "gm-def")!).messages as unknown[]) ?? [];
			expect(defMessages.length).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("set_session_name with context updates only that context session", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Create both sessions
			lineHandler(JSON.stringify({ id: "sn-init", type: "get_state", context: "Nameable" }));
			await vi.waitFor(waitForResponse("sn-init"));

			// Rename the context session
			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({ id: "sn-set", type: "set_session_name", name: "My Custom Name", context: "Nameable" }),
			);
			await vi.waitFor(waitForResponse("sn-set"));

			// Context session should now have the custom name
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "sn-check-ctx", type: "get_state", context: "Nameable" }));
			await vi.waitFor(waitForResponse("sn-check-ctx"));
			expect(getResponseData(getResponseById(rpcIo.outputLines, "sn-check-ctx")!).sessionName).toBe(
				"My Custom Name",
			);

			// Default session name is unchanged (auto-name from context creation doesn't apply here)
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "sn-check-def", type: "get_state" }));
			await vi.waitFor(waitForResponse("sn-check-def"));
			expect(getResponseData(getResponseById(rpcIo.outputLines, "sn-check-def")!).sessionName).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	it("get_session_stats routes to context session", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Send a prompt to context so it has messages to count
			lineHandler(JSON.stringify({ id: "ss-prompt", type: "prompt", message: "count me", context: "StatsCtx" }));
			await vi.waitFor(waitForEvent("agent_end", "StatsCtx"));

			// Stats for context should show messages
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ss-ctx", type: "get_session_stats", context: "StatsCtx" }));
			await vi.waitFor(waitForResponse("ss-ctx"));
			const ctxStats = getResponseData(getResponseById(rpcIo.outputLines, "ss-ctx")!);
			expect((ctxStats.userMessages as number) ?? 0).toBeGreaterThanOrEqual(1);
			expect((ctxStats.assistantMessages as number) ?? 0).toBeGreaterThanOrEqual(1);

			// Stats for default session should be empty
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ss-def", type: "get_session_stats" }));
			await vi.waitFor(waitForResponse("ss-def"));
			const defStats = getResponseData(getResponseById(rpcIo.outputLines, "ss-def")!);
			expect(defStats.userMessages as number).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("get_last_assistant_text routes to context session", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Default session has no last assistant text
			lineHandler(JSON.stringify({ id: "lat-def-before", type: "get_last_assistant_text" }));
			await vi.waitFor(waitForResponse("lat-def-before"));
			expect(getResponseData(getResponseById(rpcIo.outputLines, "lat-def-before")!).text).toBeUndefined();

			// Send prompt to context
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "lat-prompt", type: "prompt", message: "say something", context: "LatCtx" }));
			await vi.waitFor(waitForEvent("agent_end", "LatCtx"));

			// Context has last assistant text, default session still does not
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "lat-ctx", type: "get_last_assistant_text", context: "LatCtx" }));
			lineHandler(JSON.stringify({ id: "lat-def", type: "get_last_assistant_text" }));
			await vi.waitFor(() => {
				expect(getResponseById(rpcIo.outputLines, "lat-ctx")).toBeDefined();
				expect(getResponseById(rpcIo.outputLines, "lat-def")).toBeDefined();
			});

			const ctxText = getResponseData(getResponseById(rpcIo.outputLines, "lat-ctx")!).text;
			const defText = getResponseData(getResponseById(rpcIo.outputLines, "lat-def")!).text;
			expect(typeof ctxText).toBe("string"); // context has a response
			expect(defText).toBeUndefined(); // default session still empty
		} finally {
			await cleanup();
		}
	});

	it("abort with context targets only that context session", async () => {
		// Start a slow stream so the context is still streaming when we abort
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });
		try {
			// Start a prompt in context "AbortCtx"
			lineHandler(
				JSON.stringify({ id: "ab-prompt", type: "prompt", message: "long response", context: "AbortCtx" }),
			);
			await vi.waitFor(() => {
				const parsed = parseOutputLines(rpcIo.outputLines);
				expect(parsed.find((r) => r.id === "ab-prompt" && r.command === "prompt")).toBeDefined();
			});

			// Abort the context session — should succeed
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "ab-abort", type: "abort", context: "AbortCtx" }));
			await vi.waitFor(waitForResponse("ab-abort"));
			expect(getResponseById(rpcIo.outputLines, "ab-abort")!.success).toBe(true);
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// Persistence: contexts.json
	// --------------------------------------------------------------------------

	it("contexts.json is written when a context session is created", async () => {
		const { lineHandler, cleanup, sessionsDir } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "cj-init", type: "get_state", context: "PersistMe" }));
			await vi.waitFor(waitForResponse("cj-init"));

			const contextsFile = join(sessionsDir, "contexts.json");
			expect(existsSync(contextsFile)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("contexts.json maps context names to session file paths", async () => {
		const { lineHandler, cleanup, sessionsDir } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "cj-A", type: "get_state", context: "Alpha" }));
			lineHandler(JSON.stringify({ id: "cj-B", type: "get_state", context: "Beta" }));
			await vi.waitFor(() => {
				expect(getResponseById(rpcIo.outputLines, "cj-A")).toBeDefined();
				expect(getResponseById(rpcIo.outputLines, "cj-B")).toBeDefined();
			});

			const contextsFile = join(sessionsDir, "contexts.json");
			expect(existsSync(contextsFile)).toBe(true);

			const mapping = JSON.parse(readFileSync(contextsFile, "utf8")) as Record<string, string>;
			expect(Object.keys(mapping)).toContain("Alpha");
			expect(Object.keys(mapping)).toContain("Beta");
			expect(mapping["Alpha"]).toMatch(/\.jsonl$/);
			expect(mapping["Beta"]).toMatch(/\.jsonl$/);
			expect(mapping["Alpha"]).not.toBe(mapping["Beta"]);
		} finally {
			await cleanup();
		}
	});

	it("contexts.json is updated when new_session replaces a context", async () => {
		const { lineHandler, cleanup, sessionsDir } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			// Create context "Renewable"
			lineHandler(JSON.stringify({ id: "cj-r1", type: "get_state", context: "Renewable" }));
			await vi.waitFor(waitForResponse("cj-r1"));

			const contextsFile = join(sessionsDir, "contexts.json");
			const mappingBefore = JSON.parse(readFileSync(contextsFile, "utf8")) as Record<string, string>;
			const pathBefore = mappingBefore["Renewable"];
			expect(pathBefore).toBeDefined();

			// Replace the context session
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "cj-new", type: "new_session", context: "Renewable" }));
			await vi.waitFor(waitForResponse("cj-new"));

			// Trigger a get_state so the new session registers its file path in contexts.json
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "cj-r2", type: "get_state", context: "Renewable" }));
			await vi.waitFor(waitForResponse("cj-r2"));

			const mappingAfter = JSON.parse(readFileSync(contextsFile, "utf8")) as Record<string, string>;
			const pathAfter = mappingAfter["Renewable"];
			expect(pathAfter).toBeDefined();
			expect(pathAfter).not.toBe(pathBefore); // new session → new file path
		} finally {
			await cleanup();
		}
	});

	// --------------------------------------------------------------------------
	// Session resumption across restarts
	// --------------------------------------------------------------------------

	it("context session is resumed from contexts.json when RPC restarts", async () => {
		const sessionsDir = join(tmpdir(), `pi-ctx-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(sessionsDir, { recursive: true });

		let firstSessionId: string;

		// First RPC instance: create context "Persistent" and send a prompt so the session file is written
		{
			const { lineHandler, cleanup } = await startRpcModeInDir(sessionsDir, {
				withAuth: true,
				responseDelayMs: 0,
			});
			try {
				lineHandler(
					JSON.stringify({ id: "rs-prompt", type: "prompt", message: "persist me", context: "Persistent" }),
				);
				// Wait until agent_end so the session file is flushed to disk
				await vi.waitFor(waitForEvent("agent_end", "Persistent"));

				rpcIo.outputLines = [];
				lineHandler(JSON.stringify({ id: "rs-id1", type: "get_state", context: "Persistent" }));
				await vi.waitFor(waitForResponse("rs-id1"));
				firstSessionId = getResponseData(getResponseById(rpcIo.outputLines, "rs-id1")!).sessionId as string;
				expect(firstSessionId).toBeDefined();
			} finally {
				await cleanup();
			}
		}

		// Second RPC instance: same sessionsDir — context "Persistent" should load from contexts.json
		{
			rpcIo.outputLines = [];
			rpcIo.lineHandler = undefined;

			const { lineHandler, cleanup } = await startRpcModeInDir(sessionsDir, {
				withAuth: true,
				responseDelayMs: 0,
			});
			try {
				lineHandler(JSON.stringify({ id: "rs-id2", type: "get_state", context: "Persistent" }));
				await vi.waitFor(waitForResponse("rs-id2"));
				const secondSessionId = getResponseData(getResponseById(rpcIo.outputLines, "rs-id2")!).sessionId as string;

				// Session ID must match the first run — same conversation was resumed
				expect(secondSessionId).toBe(firstSessionId);
			} finally {
				await cleanup();
				rmSync(sessionsDir, { recursive: true });
			}
		}
	});

	it("missing session file in contexts.json causes a fresh session to be created on restart", async () => {
		const sessionsDir = join(tmpdir(), `pi-ctx-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(sessionsDir, { recursive: true });

		let firstSessionId: string;

		// First run: create context "Stale"
		{
			const { lineHandler, cleanup } = await startRpcModeInDir(sessionsDir, {
				withAuth: true,
				responseDelayMs: 0,
			});
			try {
				lineHandler(JSON.stringify({ id: "ms-id1", type: "get_state", context: "Stale" }));
				await vi.waitFor(waitForResponse("ms-id1"));
				firstSessionId = getResponseData(getResponseById(rpcIo.outputLines, "ms-id1")!).sessionId as string;
			} finally {
				await cleanup();
			}
		}

		// Delete all session JSONL files to simulate a missing session (stale contexts.json entry)
		const sessionFiles = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")) : [];
		for (const f of sessionFiles as string[]) {
			rmSync(join(sessionsDir, f));
		}

		// Second run: session file is gone → fresh session created
		{
			rpcIo.outputLines = [];
			rpcIo.lineHandler = undefined;

			const { lineHandler, cleanup } = await startRpcModeInDir(sessionsDir, {
				withAuth: true,
				responseDelayMs: 0,
			});
			try {
				lineHandler(JSON.stringify({ id: "ms-id2", type: "get_state", context: "Stale" }));
				await vi.waitFor(waitForResponse("ms-id2"));
				const newSessionId = getResponseData(getResponseById(rpcIo.outputLines, "ms-id2")!).sessionId as string;

				// Fresh session: different ID, still auto-named
				expect(newSessionId).not.toBe(firstSessionId);
				expect(getResponseData(getResponseById(rpcIo.outputLines, "ms-id2")!).sessionName).toBe("Stale");
			} finally {
				await cleanup();
				rmSync(sessionsDir, { recursive: true });
			}
		}
	});
});
