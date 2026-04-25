/**
 * Tests for context-aware routing in ExtensionRunner / ExtensionAPI.
 *
 * Covers:
 *   1. ExtensionContext.context reflects the session name (= RPC context name for context sessions)
 *   2. pi.sendUserMessageToContext routes to the registered handler
 *   3. pi.sendMessageToContext routes to the registered handler
 *   4. bindExtensions wires context routing callbacks through to the runner
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// ─── Shared fixtures (mirrors extensions-runner.test.ts) ─────────────────────

let tempDir: string;
let extensionsDir: string;
let sessionManager: SessionManager;
let modelRegistry: ModelRegistry;
let modelRuntime: ModelRuntime;

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-ctx-test-"));
	extensionsDir = path.join(tempDir, "extensions");
	fs.mkdirSync(extensionsDir);
	sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
	modelRegistry = await createModelRegistry(authStorage);
	modelRuntime = getModelRuntime(modelRegistry);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	retryLastTurn: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
	isProjectTrusted: () => true,
};

// ─── Mock agent (no real LLM calls) ─────────────────────────────────────────

class MockStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected");
			},
		);
	}
}

function createMockAgent(): Agent {
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("test model not found");
	return new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "test", tools: [] },
		streamFn: () => {
			const s = new MockStream();
			queueMicrotask(() => {
				s.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
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
					},
				});
			});
			return s;
		},
	});
}

// ─── 1. ExtensionContext.context ──────────────────────────────────────────────

describe("ExtensionContext.context", () => {
	it("is undefined when getSessionName returns undefined", async () => {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore({ ...extensionActions, getSessionName: () => undefined }, extensionContextActions);

		const ctx = runner.createContext();
		expect(ctx.context).toBeUndefined();
	});

	it("matches the value returned by getSessionName", async () => {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore({ ...extensionActions, getSessionName: () => "+81001234567" }, extensionContextActions);

		const ctx = runner.createContext();
		expect(ctx.context).toBe("+81001234567");
	});

	it("reflects updated session name after bindCore runs", async () => {
		let currentName: string | undefined;
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore({ ...extensionActions, getSessionName: () => currentName }, extensionContextActions);

		const ctx = runner.createContext();
		expect(ctx.context).toBeUndefined();

		currentName = "group.abc123";
		expect(ctx.context).toBe("group.abc123");
	});
});

// ─── 2. pi.sendUserMessageToContext ─────────────────────────────────────────

describe("pi.sendUserMessageToContext", () => {
	it("is a no-op when no handler has been registered (does not throw)", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("session_start", async () => {
					pi.sendUserMessageToContext("Alice", "hello");
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "ctx-noop.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);

		// No handler set — should not throw
		await expect(runner.emit({ type: "session_start", reason: "startup" })).resolves.toBeUndefined();
	});

	it("calls the registered handler with contextName and content", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("session_start", async () => {
					pi.sendUserMessageToContext("Alice", "hello context");
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "ctx-send.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		const captured: Array<{ contextName: string; content: unknown }> = [];
		runner.setSendUserMessageToContext((contextName, content) => {
			captured.push({ contextName, content });
		});

		runner.bindCore(extensionActions, extensionContextActions);
		await runner.emit({ type: "session_start", reason: "startup" });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.contextName).toBe("Alice");
		expect(captured[0]?.content).toBe("hello context");
	});

	it("can be updated after bindCore", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("agent_end", async () => {
					pi.sendUserMessageToContext("Bob", "later");
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "ctx-late.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);

		// Set handler AFTER bindCore
		const captured: Array<{ contextName: string; content: unknown }> = [];
		runner.setSendUserMessageToContext((contextName, content) => {
			captured.push({ contextName, content });
		});

		await runner.emit({ type: "agent_end", messages: [] });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.contextName).toBe("Bob");
		expect(captured[0]?.content).toBe("later");
	});
});

// ─── 3. pi.sendMessageToContext ───────────────────────────────────────────────

describe("pi.sendMessageToContext", () => {
	it("is a no-op when no handler has been registered (does not throw)", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("session_start", async () => {
					pi.sendMessageToContext("Alice", { customType: "test", content: [], display: false, details: {} });
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "ctx-msg-noop.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);

		await expect(runner.emit({ type: "session_start", reason: "startup" })).resolves.toBeUndefined();
	});

	it("calls the registered handler with contextName and message", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("session_start", async () => {
					pi.sendMessageToContext("Alice", {
						customType: "scheduled_prompt",
						content: [{ type: "text", text: "reminder" }],
						display: true,
						details: { jobId: "j1" },
					});
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "ctx-msg-send.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		const captured: Array<{ contextName: string; message: unknown }> = [];
		runner.setSendMessageToContext((contextName, message) => {
			captured.push({ contextName, message });
		});

		runner.bindCore(extensionActions, extensionContextActions);
		await runner.emit({ type: "session_start", reason: "startup" });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.contextName).toBe("Alice");
		expect(captured[0]?.message).toMatchObject({
			customType: "scheduled_prompt",
			display: true,
			details: { jobId: "j1" },
		});
	});
});

// ─── 4. bindExtensions integration ───────────────────────────────────────────

describe("bindExtensions context routing", () => {
	it("wires sendUserMessageToContext from bindings through to extension calls", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("session_start", async () => {
					pi.sendUserMessageToContext("+alice", "from session_start");
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "bind-user-ctx.ts"), extCode);

		const extensionsResult = await discoverAndLoadExtensions([], tempDir, tempDir);
		const resourceLoader = createTestResourceLoader({ extensionsResult });

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const session = new AgentSession({
			agent: createMockAgent(),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
		});

		const captured: Array<{ contextName: string; content: unknown }> = [];
		await session.bindExtensions({
			sendUserMessageToContext: (contextName, content) => {
				captured.push({ contextName, content });
			},
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.contextName).toBe("+alice");
		expect(captured[0]?.content).toBe("from session_start");

		session.dispose();
	});

	it("wires sendMessageToContext from bindings through to extension calls", async () => {
		const extCode = `
			export default function(pi) {
				pi.on("session_start", async () => {
					pi.sendMessageToContext("group.xyz", {
						customType: "reminder",
						content: [],
						display: false,
						details: null,
					});
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "bind-msg-ctx.ts"), extCode);

		const extensionsResult = await discoverAndLoadExtensions([], tempDir, tempDir);
		const resourceLoader = createTestResourceLoader({ extensionsResult });

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const session = new AgentSession({
			agent: createMockAgent(),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
		});

		const captured: Array<{ contextName: string; message: unknown }> = [];
		await session.bindExtensions({
			sendMessageToContext: (contextName, message) => {
				captured.push({ contextName, message });
			},
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.contextName).toBe("group.xyz");
		expect(captured[0]?.message).toMatchObject({ customType: "reminder" });

		session.dispose();
	});
});
