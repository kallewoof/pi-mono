import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	clearImageInputDowngrades,
	EventStream,
	type Message,
	type Model,
	modelAcceptsImageInput,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

const MMPROJ_ERROR =
	'500: {"code":500,"message":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj","type":"server_error"}';

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

function createVisionModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "llama.cpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "llama.cpp",
		model: "mock",
		usage: createUsage(),
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Transcript that ends in a read tool result carrying an image. */
function createImageContext(): AgentContext {
	return {
		systemPrompt: "",
		messages: [
			{ role: "user", content: "who is on the cover?", timestamp: Date.now() },
			createAssistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "cover.png" } }]),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: Date.now(),
			},
		],
		tools: [],
	};
}

function createStreamFn(responses: Array<() => AssistantMessageEvent>): { fn: StreamFn; models: Array<Model<Api>> } {
	const models: Array<Model<Api>> = [];
	const fn: StreamFn = (model) => {
		models.push({ ...model });
		const event = responses[Math.min(models.length - 1, responses.length - 1)]();
		const stream = new MockAssistantStream();
		queueMicrotask(() => stream.push(event));
		return stream;
	};
	return { fn, models };
}

function errorEvent(errorMessage: string): AssistantMessageEvent {
	return { type: "error", reason: "error", error: createAssistantMessage([], "error", errorMessage) };
}

function doneEvent(text: string): AssistantMessageEvent {
	return { type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text }]) };
}

afterEach(() => {
	clearImageInputDowngrades();
});

describe("image input downgrade", () => {
	it("retries once without images when the endpoint rejects image input", async () => {
		const model = createVisionModel("vlm-retry");
		const context = createImageContext();
		const { fn, models } = createStreamFn([() => errorEvent(MMPROJ_ERROR), () => doneEvent("I cannot see images.")]);
		const config: AgentLoopConfig = { model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, fn);
		for await (const event of stream) {
			events.push(event);
		}
		await stream.result();

		expect(models.length).toBe(2);
		// The retry goes out with the model downgraded, so transformMessages
		// replaces the image with a placeholder instead of resending it.
		expect(modelAcceptsImageInput(models[1])).toBe(false);

		const last = context.messages[context.messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		// The failed attempt is never committed to the transcript or emitted.
		expect(context.messages.filter((m) => m.role === "assistant" && m.stopReason === "error").length).toBe(0);
		const assistantEnds = events.filter((e) => e.type === "message_end" && e.message.role === "assistant");
		expect(assistantEnds.length).toBe(1);
	});

	it("does not retry when the transcript carries no images", async () => {
		const model = createVisionModel("vlm-no-images");
		const context: AgentContext = {
			systemPrompt: "",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			tools: [],
		};
		const { fn, models } = createStreamFn([() => errorEvent(MMPROJ_ERROR)]);

		const stream = agentLoopContinue(context, { model, convertToLlm: identityConverter }, undefined, fn);
		await stream.result();

		expect(models.length).toBe(1);
		expect(modelAcceptsImageInput(model)).toBe(true);
	});

	it("does not retry on unrelated provider errors", async () => {
		const model = createVisionModel("vlm-unrelated");
		const context = createImageContext();
		const { fn, models } = createStreamFn([() => errorEvent("429: rate limit exceeded")]);

		const stream = agentLoopContinue(context, { model, convertToLlm: identityConverter }, undefined, fn);
		await stream.result();

		expect(models.length).toBe(1);
		expect(modelAcceptsImageInput(model)).toBe(true);
	});

	it("retries at most once per model", async () => {
		const model = createVisionModel("vlm-persistent");
		const { fn, models } = createStreamFn([() => errorEvent(MMPROJ_ERROR)]);
		const config: AgentLoopConfig = { model, convertToLlm: identityConverter };

		await agentLoopContinue(createImageContext(), config, undefined, fn).result();
		expect(models.length).toBe(2);

		// Second turn: the model is already known to be image-less, so no extra attempt.
		await agentLoopContinue(createImageContext(), config, undefined, fn).result();
		expect(models.length).toBe(3);
	});
});
