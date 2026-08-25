import { afterEach, describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Message, Model, ToolResultMessage, UserMessage } from "../src/types.ts";
import {
	clearImageInputDowngrades,
	hasImageContent,
	isImageInputUnsupportedError,
	markImageInputUnsupported,
	modelAcceptsImageInput,
} from "../src/utils/image-support.ts";

function makeVisionModel(id = "local-vlm"): Model<"openai-completions"> {
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

function makeImageToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		],
		isError: false,
		timestamp: Date.now(),
	};
}

function makeImageUserMessage(): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "what is this" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		],
		timestamp: Date.now(),
	};
}

afterEach(() => {
	clearImageInputDowngrades();
});

describe("image input runtime downgrade", () => {
	it("detects endpoint errors that mean image input is unsupported", () => {
		expect(
			isImageInputUnsupportedError(
				'500: {"code":500,"message":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj","type":"server_error"}',
			),
		).toBe(true);
		expect(isImageInputUnsupportedError("This model does not support image input")).toBe(true);
		expect(isImageInputUnsupportedError("Invalid content type. image_url is only supported by certain models.")).toBe(
			true,
		);
		expect(isImageInputUnsupportedError("429: rate limit exceeded")).toBe(false);
		expect(isImageInputUnsupportedError(undefined)).toBe(false);
	});

	it("finds images in user and tool result messages", () => {
		expect(hasImageContent([makeImageUserMessage()])).toBe(true);
		expect(hasImageContent([makeImageToolResult()])).toBe(true);
		expect(hasImageContent([{ role: "user", content: "no image", timestamp: Date.now() }])).toBe(false);
	});

	it("marks a model only once so callers retry at most once", () => {
		const model = makeVisionModel();
		expect(modelAcceptsImageInput(model)).toBe(true);
		expect(markImageInputUnsupported(model)).toBe(true);
		expect(markImageInputUnsupported(model)).toBe(false);
		expect(modelAcceptsImageInput(model)).toBe(false);
	});

	it("scopes the downgrade to the model that failed", () => {
		markImageInputUnsupported(makeVisionModel("local-vlm"));
		expect(modelAcceptsImageInput(makeVisionModel("other-vlm"))).toBe(true);
	});

	it("strips images from the transcript once the endpoint rejected them", () => {
		const model = makeVisionModel();
		const messages: Message[] = [makeImageUserMessage(), makeImageToolResult()];

		const before = transformMessages(messages, model);
		expect(hasImageContent(before)).toBe(true);

		markImageInputUnsupported(model);

		const after = transformMessages(messages, model);
		expect(hasImageContent(after)).toBe(false);
		const toolResult = after.find((msg) => msg.role === "toolResult") as ToolResultMessage;
		expect(toolResult.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "text", text: "(tool image omitted: model does not support images)" },
		]);
	});
});
