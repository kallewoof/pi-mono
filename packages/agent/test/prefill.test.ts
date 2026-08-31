import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	QueuedAgentMessage,
} from "../src/types.ts";

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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createCompletionsModel(): Model<"openai-completions"> {
	return {
		id: "mock-local",
		name: "mock-local",
		api: "openai-completions",
		provider: "llamacpp",
		baseUrl: "http://localhost:22400/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 8192,
	};
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "mock",
		name: "mock",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Last message of each request the loop issued, so tests can assert what the provider saw. */
function trailingMessages(contexts: Context[]): Array<Message | undefined> {
	return contexts.map((context) => context.messages[context.messages.length - 1]);
}

function assistantText(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function assistantThinking(message: AgentMessage | Message | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("");
}

describe("prefill", () => {
	it("sends the prefill as a trailing assistant message and merges it into the response", async () => {
		const contexts: Context[] = [];
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: " step one is to read the file." }]);
				const partial = createAssistantMessage([{ type: "text", text: " step one" }]);
				stream.push({ type: "start", partial: createAssistantMessage([]) });
				stream.push({ type: "text_delta", contentIndex: 0, delta: " step one", partial });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prefill: "Plan:",
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Do the thing")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		const trailing = trailingMessages(contexts)[0];
		expect(trailing?.role).toBe("assistant");
		expect(assistantText(trailing as AgentMessage)).toBe("Plan:");

		// The response the loop reports covers the prefill plus the continuation.
		expect(assistantText(messages[1])).toBe("Plan: step one is to read the file.");
		const messageEnds = events.filter((event) => event.type === "message_end");
		const lastMessageEnd = messageEnds[messageEnds.length - 1];
		expect(assistantText(lastMessageEnd?.type === "message_end" ? lastMessageEnd.message : undefined)).toBe(
			"Plan: step one is to read the file.",
		);

		// Streaming snapshots carry it too, so a live renderer never shows a decapitated response.
		const update = events.find((event) => event.type === "message_update");
		expect(assistantText(update?.type === "message_update" ? update.message : undefined)).toBe("Plan: step one");
	});

	it("trims trailing whitespace, which providers reject on a prefill", async () => {
		const contexts: Context[] = [];
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "continued" }]),
				});
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prefill: "Answer:  \n",
		};

		await agentLoop([createUserMessage("Go")], context, config, undefined, streamFn).result();

		expect(assistantText(trailingMessages(contexts)[0] as AgentMessage)).toBe("Answer:");
	});

	it("primes the request a queued message triggers, not one already sent", async () => {
		const contexts: Context[] = [];
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: " continued." }]);
				stream.push({ type: "start", partial: createAssistantMessage([]) });
				stream.push({ type: "text_delta", contentIndex: 0, delta: " continued.", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// A follow-up waits for the current run to wind down, so the run's own prefill is spent
		// long before it is delivered. Its priming rides along with the message instead.
		let followUps: QueuedAgentMessage[] = [
			{ message: createUserMessage("and now the other thing"), prefill: "Then:" },
		];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getFollowUpMessages: async () => {
				const next = followUps;
				followUps = [];
				return next;
			},
		};

		const messages = await agentLoop(
			[createUserMessage("Do the thing")],
			context,
			config,
			undefined,
			streamFn,
		).result();

		expect(contexts).toHaveLength(2);
		expect(trailingMessages(contexts)[0]?.role).toBe("user");
		expect(assistantText(trailingMessages(contexts)[1] as AgentMessage)).toBe("Then:");
		expect(assistantText(messages[messages.length - 1])).toBe("Then: continued.");
	});

	it("primes only the first request of a run", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
			},
		};

		const contexts: Context[] = [];
		let call = 0;
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			const message =
				call++ === 0
					? createAssistantMessage(
							[{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "hi" } }],
							"toolUse",
						)
					: createAssistantMessage([{ type: "text", text: "done" }]);
			queueMicrotask(() => {
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prefill: "Plan:",
		};

		await agentLoop([createUserMessage("echo hi")], context, config, undefined, streamFn).result();

		expect(contexts.length).toBe(2);
		expect(trailingMessages(contexts)[0]?.role).toBe("assistant");
		// The follow-up request ends with the tool result, not with the prefill.
		expect(trailingMessages(contexts)[1]?.role).toBe("toolResult");
	});

	it("keeps the prefill as its own block when the response has no text to continue", async () => {
		let call = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			const first = call++ === 0;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage([]) });
				if (first) {
					// The tool does not exist, so the loop reports an error result and asks again.
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "gave up" }]),
				});
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prefill: "Plan:",
		};

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, streamFn).result();

		const assistant = messages[1];
		expect(assistant.role).toBe("assistant");
		if (assistant.role === "assistant") {
			expect(assistant.content[0]).toEqual({ type: "text", text: "Plan:" });
			expect(assistant.content[1].type).toBe("toolCall");
		}
	});

	it("leaves a failure that never started streaming untouched", async () => {
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "" }], "error");
				message.errorMessage = "boom";
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prefill: "Plan:",
		};

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, streamFn).result();

		expect(messages[1].role).toBe("assistant");
		expect(assistantText(messages[1])).toBe("");
	});
});

describe("thinking prefill", () => {
	function createCompletionsAssistantMessage(
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"] = "stop",
	): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "llamacpp",
			model: "mock-local",
			usage: createUsage(),
			stopReason,
			timestamp: Date.now(),
		};
	}

	it("sends the reasoning prefill as a thinking block naming its request field", async () => {
		const contexts: Context[] = [];
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createCompletionsAssistantMessage([
					{ type: "thinking", thinking: " So I must use Roman numerals.", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "LI" },
				]);
				stream.push({ type: "start", partial: createCompletionsAssistantMessage([]) });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createCompletionsModel(),
			convertToLlm: identityConverter,
			prefill: { thinking: "All numeric answers must be Roman numerals." },
		};

		const messages = await agentLoop([createUserMessage("17*3?")], context, config, undefined, streamFn).result();

		const trailing = trailingMessages(contexts)[0];
		expect(trailing?.role).toBe("assistant");
		expect(assistantThinking(trailing)).toBe("All numeric answers must be Roman numerals.");
		if (trailing?.role === "assistant") {
			const thinkingBlock = trailing.content.find((block) => block.type === "thinking");
			// The adapter writes the reasoning to the request field the signature names.
			expect(thinkingBlock?.type === "thinking" ? thinkingBlock.thinkingSignature : undefined).toBe(
				"reasoning_content",
			);
			// Reasoning-only prefill: no text block invented alongside it.
			expect(trailing.content.some((block) => block.type === "text")).toBe(false);
		}

		expect(assistantThinking(messages[1])).toBe(
			"All numeric answers must be Roman numerals. So I must use Roman numerals.",
		);
		expect(assistantText(messages[1])).toBe("LI");
	});

	it("does not duplicate a prefill an endpoint echoes back", async () => {
		// llama.cpp returns the primed text at the head of its response rather than only the continuation.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createCompletionsAssistantMessage([
					{
						type: "thinking",
						thinking: "Check the units first. They are metric, so no conversion is needed.",
						thinkingSignature: "reasoning_content",
					},
					{ type: "text", text: "12 km" },
				]);
				stream.push({ type: "start", partial: createCompletionsAssistantMessage([]) });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createCompletionsModel(),
			convertToLlm: identityConverter,
			prefill: { thinking: "Check the units first." },
		};

		const messages = await agentLoop([createUserMessage("how far?")], context, config, undefined, streamFn).result();

		expect(assistantThinking(messages[1])).toBe(
			"Check the units first. They are metric, so no conversion is needed.",
		);
	});

	it("drops a reasoning prefill for an API that cannot carry one", async () => {
		const contexts: Context[] = [];
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "answer" }]),
				});
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			// Anthropic rejects a synthesized thinking block, so priming reasoning is skipped there.
			model: createModel(),
			convertToLlm: identityConverter,
			prefill: { thinking: "Think about this carefully." },
		};

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, streamFn).result();

		expect(trailingMessages(contexts)[0]?.role).toBe("user");
		expect(assistantThinking(messages[1])).toBe("");
	});

	it("primes reasoning and response together", async () => {
		const contexts: Context[] = [];
		const streamFn = (_model: Model<any>, context: Context) => {
			contexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createCompletionsAssistantMessage([
					{ type: "thinking", thinking: " and the file is small.", thinkingSignature: "reasoning_content" },
					{ type: "text", text: " read the file." },
				]);
				stream.push({ type: "start", partial: createCompletionsAssistantMessage([]) });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createCompletionsModel(),
			convertToLlm: identityConverter,
			prefill: { thinking: "The user wants the plan first", text: "Step one:" },
		};

		const messages = await agentLoop([createUserMessage("go")], context, config, undefined, streamFn).result();

		const trailing = trailingMessages(contexts)[0];
		expect(assistantThinking(trailing)).toBe("The user wants the plan first");
		expect(assistantText(trailing as AgentMessage)).toBe("Step one:");
		expect(assistantThinking(messages[1])).toBe("The user wants the plan first and the file is small.");
		expect(assistantText(messages[1])).toBe("Step one: read the file.");
	});
});
