/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, ExtensionBindings } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	SessionShutdownEvent,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { emitSessionShutdownEvent } from "../../core/extensions/runner.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	// Named context sessions: each context name maps to an independent AgentSession.
	const contextSessions = new Map<string, AgentSession>();
	const contextUnsubscribers = new Map<string, () => void>();
	const contextFiles = new Map<string, string>();

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	// Lazy ref to avoid TDZ: getOrCreateContextSession is defined after the first rebindSession call.
	let contextRouter: ((name: string) => Promise<AgentSession>) | undefined;

	// Resolve a named context session and run `action` against it. These calls are
	// fire-and-forget from the extension's perspective — it gets no promise back
	// and cannot observe a rejection — so a failure here is the last chance to say
	// anything about it. Report to stderr (stdout is the RPC protocol channel)
	// rather than discarding: a silently dropped cross-context send is invisible
	// from both sides and indistinguishable from the extension never firing.
	const routeToContext = async (
		contextName: string,
		operation: string,
		action: (ctxSession: AgentSession) => Promise<void>,
	): Promise<void> => {
		if (!contextRouter) {
			console.error(`[rpc] ${operation}(${contextName}) dropped: no context router bound`);
			return;
		}
		try {
			await action(await contextRouter(contextName));
		} catch (err) {
			const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.error(`[rpc] ${operation}(${contextName}) failed: ${message}`);
		}
	};

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const buildSessionBindings = (target: AgentSession): ExtensionBindings => ({
		uiContext: createExtensionUIContext(),
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => target.agent.waitForIdle(),
			newSession: async (options) => runtimeHost.newSession(options),
			fork: async (entryId, forkOptions) => {
				const result = await runtimeHost.fork(entryId, forkOptions);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await target.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => {
				return runtimeHost.switchSession(sessionPath, options);
			},
			reload: async () => {
				await target.reload();
			},
		},
		shutdownHandler: () => {
			shutdownRequested = true;
		},
		onError: (err) => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		sendUserMessageToContext: (contextName, content, options) => {
			void routeToContext(contextName, "sendUserMessageToContext", (ctxSession) =>
				ctxSession.sendUserMessage(content, options),
			);
		},
		sendMessageToContext: (contextName, message, options) => {
			void routeToContext(contextName, "sendMessageToContext", async (ctxSession) => {
				// A custom message with no explicit delivery mode is a notification
				// bound for the RPC client (e.g. pi-schedule-prompt reporting a
				// command-mode job's output). sendCustomMessage only emits the
				// message_start/message_end pair the client needs when the session is
				// idle; mid-run it steers the message into the agent, which emits it
				// only if the turn goes on to carry it — and drops it outright when
				// the run is already unwinding. Wait for the run to settle first so
				// delivery does not depend on that race.
				if (options?.deliverAs === undefined && !options?.triggerTurn && ctxSession.isStreaming) {
					await ctxSession.waitForIdle();
				}
				await ctxSession.sendCustomMessage(message, options);
			});
		},
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions(buildSessionBindings(session));

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Load persisted context name → session file mappings.
	const contextsFilePath = join(session.sessionManager.getSessionDir(), "contexts.json");
	if (existsSync(contextsFilePath)) {
		try {
			const saved = JSON.parse(readFileSync(contextsFilePath, "utf8")) as Record<string, string>;
			for (const [name, path] of Object.entries(saved)) {
				contextFiles.set(name, path);
			}
		} catch {
			// Ignore malformed contexts.json
		}
	}

	const getOrCreateContextSession = async (contextName: string): Promise<AgentSession> => {
		const existing = contextSessions.get(contextName);
		if (existing) return existing;

		let ctxSession: AgentSession;
		const savedPath = contextFiles.get(contextName);
		if (savedPath && existsSync(savedPath)) {
			ctxSession = await runtimeHost.loadIsolatedSession(savedPath);
		} else {
			ctxSession = await runtimeHost.createIsolatedSession();
			ctxSession.setSessionName(contextName);
		}

		const sessionFile = ctxSession.sessionFile;
		if (sessionFile) {
			contextFiles.set(contextName, sessionFile);
			writeFileSync(contextsFilePath, JSON.stringify(Object.fromEntries(contextFiles), null, 2));
		}

		// Same wire shape as the default session: toJsonEvent strips the cumulative
		// assistant snapshot from message_update, leaving the delta plus the context tag.
		const unsub = ctxSession.subscribe((event) => output({ ...toJsonEvent(event), context: contextName }));
		contextUnsubscribers.set(contextName, unsub);
		contextSessions.set(contextName, ctxSession);

		// Bind extensions so the session's extension runner fires session_start
		// and gets full bindings (UI, command actions, error handling, and the
		// cross-context routing handlers used by extensions like pi-schedule-prompt).
		// Without this, extensions like mcp-adapter never initialize their state
		// and report "MCP not initialized" when called from this context.
		await ctxSession.bindExtensions(buildSessionBindings(ctxSession));

		return ctxSession;
	};
	contextRouter = getOrCreateContextSession;

	/**
	 * Retire a context session the way every other host does: emit
	 * `session_shutdown` to its extensions *before* disposing it.
	 *
	 * `AgentSession.dispose()` only invalidates the extension runner — it does not
	 * notify extensions. An extension that owns background state keyed to the
	 * session (timers, subprocesses; pi-schedule-prompt's CronScheduler is the
	 * motivating case) therefore never got its teardown hook here, and kept
	 * running against a ctx that throws "stale ctx" on every call: its cron timers
	 * stayed armed, fired on schedule, and silently dropped every delivery.
	 */
	const disposeContextSession = async (
		ctxSession: AgentSession,
		reason: SessionShutdownEvent["reason"],
	): Promise<void> => {
		await emitSessionShutdownEvent(ctxSession.extensionRunner, { type: "session_shutdown", reason });
		ctxSession.dispose();
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		const contextName = command.context;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				const promptSession = contextName ? await getOrCreateContextSession(contextName) : session;
				const ctx = contextName ? { context: contextName } : {};
				let preflightSucceeded = false;
				void promptSession
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output({ ...success(id, "prompt"), ...ctx });
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output({ ...error(id, "prompt", e.message), ...ctx });
						}
					});
				return undefined;
			}

			case "steer": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				await activeSession.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				await activeSession.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				await activeSession.abort();
				return success(id, "abort");
			}

			case "clear_queue": {
				return success(id, "clear_queue", session.clearQueue());
			}

			case "new_session": {
				if (contextName) {
					// Replace context session with a fresh one.
					const old = contextSessions.get(contextName);
					if (old) {
						contextUnsubscribers.get(contextName)?.();
						contextUnsubscribers.delete(contextName);
						await disposeContextSession(old, "new");
						contextSessions.delete(contextName);
					}
					// Drop the persisted mapping as well: "new session" must start
					// empty, and getOrCreateContextSession resumes from contextFiles
					// whenever the file is still there.
					contextFiles.delete(contextName);
					// Build the replacement through getOrCreateContextSession rather
					// than inline, so it gets the *same* wiring as any other context
					// session — above all bindExtensions(), which emits session_start
					// and installs the UI / cross-context routing handlers. Recreating
					// it by hand here left every extension uninitialised in the new
					// session (no session_start, no tools state, no scheduler).
					await getOrCreateContextSession(contextName);
					return success(id, "new_session", { cancelled: false });
				}
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				const state: RpcSessionState = {
					model: activeSession.model,
					thinkingLevel: activeSession.thinkingLevel,
					isStreaming: activeSession.isStreaming,
					isCompacting: activeSession.isCompacting,
					steeringMode: activeSession.steeringMode,
					followUpMode: activeSession.followUpMode,
					sessionFile: activeSession.sessionFile,
					sessionId: activeSession.sessionId,
					sessionName: activeSession.sessionName,
					autoCompactionEnabled: activeSession.autoCompactionEnabled,
					messageCount: activeSession.messages.length,
					pendingMessageCount: activeSession.pendingMessageCount,
					context: contextName,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				const result = await activeSession.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				const stats = activeSession.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				const text = activeSession.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				activeSession.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				const activeSession = contextName ? await getOrCreateContextSession(contextName) : session;
				return success(id, "get_messages", { messages: activeSession.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		for (const unsub of contextUnsubscribers.values()) {
			unsub();
		}
		for (const ctxSession of contextSessions.values()) {
			await disposeContextSession(ctxSession, "quit");
		}
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
