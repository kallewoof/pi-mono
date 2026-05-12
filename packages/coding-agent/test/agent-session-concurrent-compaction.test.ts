import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Controllable mock for compact() — each call pushes a Deferred so the test
// can resolve invocations in a deterministic order.
type CompactResult = { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
const compactDeferreds: Array<{ resolve: (v: CompactResult) => void; reject: (e: unknown) => void }> = [];

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: () =>
		new Promise<CompactResult>((resolve, reject) => {
			compactDeferreds.push({ resolve, reject });
		}),
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: () => true,
}));

describe("AgentSession concurrent auto-compaction", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-concurrent-compaction-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		compactDeferreds.length = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model not found");

		const agent = new Agent({
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("unused");
			},
		});

		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		const modelRuntime = getModelRuntime(modelRegistry);
		await modelRuntime.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	// Reproduces the "Auto-compaction failed: Cannot read properties of undefined (reading 'signal')"
	// crash observed when a scheduled prompt arrives while a threshold auto-compaction is in flight.
	//
	// The real-world sequence is:
	//   1. agent_end fires -> _checkCompaction(msg) -> _runAutoCompaction("threshold") [A]
	//   2. A sets _autoCompactionAbortController and awaits compact()
	//   3. Scheduled prompt arrives via prompt() -> pre-send _checkCompaction -> _runAutoCompaction [B]
	//   4. B overwrites _autoCompactionAbortController and also awaits compact()
	//   5. A's compact() resolves first -> finally clears _autoCompactionAbortController = undefined
	//   6. B's compact() resolves -> reads this._autoCompactionAbortController.signal.aborted -> crash
	it("must not crash with 'Cannot read properties of undefined' when two auto-compactions overlap", async () => {
		const errorEvents: string[] = [];
		const successEvents: number[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				if (event.errorMessage) errorEvents.push(event.errorMessage);
				if (event.result) successEvents.push(event.result.tokensBefore);
			}
		});

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		// Start two overlapping invocations.
		const first = runAutoCompaction("threshold", false);
		const second = runAutoCompaction("threshold", false);

		// Let both invocations progress past auth and reach the compact() await
		// (or, with the fix, let the second invocation bail out early).
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}

		// Resolve any pending compact() deferreds in order. With the bug present
		// there are two; A finishes first and clears _autoCompactionAbortController,
		// then B awakens and crashes on undefined.signal. With the fix there is
		// only one, since the second invocation returned early.
		let idx = 0;
		while (idx < compactDeferreds.length) {
			compactDeferreds[idx].resolve({
				summary: `summary-${idx}`,
				firstKeptEntryId: "entry-1",
				tokensBefore: 100 + idx,
				details: {},
			});
			// Let the awaiter run its post-compact code and the next one (if any)
			// reach its compact() await before resolving it.
			for (let i = 0; i < 5; i++) {
				await Promise.resolve();
			}
			idx++;
		}
		await Promise.all([first, second]);

		const crashes = errorEvents.filter((m) => m.includes("Cannot read properties of undefined"));
		expect(crashes).toEqual([]);
	});

	// Both real call sites (agent_end's _checkCompaction and prompt()'s pre-send
	// _checkCompaction) await _runAutoCompaction and then proceed assuming the
	// session has been compacted. If a second caller resolves before the in-flight
	// compaction actually finishes, that caller's post-await code runs against the
	// uncompacted session — e.g. prompt() sends the next user message against the
	// old, oversized context.
	it("both concurrent callers' post-compaction code must observe the compacted session", async () => {
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		const countCompactionEntries = () => sessionManager.getEntries().filter((e) => e.type === "compaction").length;

		let aObservedEntries = -1;
		let bObservedEntries = -1;

		const aDone = runAutoCompaction("threshold", false).then(() => {
			aObservedEntries = countCompactionEntries();
		});
		const bDone = runAutoCompaction("threshold", false).then(() => {
			bObservedEntries = countCompactionEntries();
		});

		// Drain microtasks so any synchronous early-return paths get to resolve
		// their .then() callbacks before we resolve the real compact() promise.
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		// Resolve compact() invocations one at a time, draining microtasks in
		// between so awaiters can progress.
		let idx = 0;
		while (idx < compactDeferreds.length) {
			compactDeferreds[idx].resolve({
				summary: `summary-${idx}`,
				firstKeptEntryId: "entry-1",
				tokensBefore: 100 + idx,
				details: {},
			});
			for (let i = 0; i < 20; i++) {
				await Promise.resolve();
			}
			idx++;
		}
		await Promise.all([aDone, bDone]);

		// Both callers must have seen at least one compaction entry by the time
		// their post-await code ran. If a caller saw zero, it would have proceeded
		// (e.g. sent the next prompt) against the pre-compaction session.
		expect(aObservedEntries).toBeGreaterThanOrEqual(1);
		expect(bObservedEntries).toBeGreaterThanOrEqual(1);
	});
});
