// Runtime tracking of endpoints that reject image input.
//
// A model's catalog entry can advertise image input while the endpoint serving
// it cannot accept images: the common case is a local llama.cpp server started
// without an mmproj file, which answers any request carrying an image with
// `500 image input is not supported`. Because the image stays in the transcript,
// every subsequent request fails the same way and the session is stuck.
//
// `markImageInputUnsupported` records the endpoint's answer so
// `modelAcceptsImageInput` (consulted by `transformMessages`) downgrades the
// model for the rest of the process, replacing images with a text placeholder
// instead of resending them.

import type { Api, Message, Model } from "../types.ts";

const imageInputUnsupported = new Set<string>();

function modelKey(model: Model<Api>): string {
	return `${model.provider}|${model.api}|${model.baseUrl}|${model.id}`;
}

/** True when the model advertises image input and no endpoint has rejected it at runtime. */
export function modelAcceptsImageInput(model: Model<Api>): boolean {
	return model.input.includes("image") && !imageInputUnsupported.has(modelKey(model));
}

/**
 * Record that this model's endpoint rejected image input.
 * Returns false when it was already recorded, so callers can retry exactly once.
 */
export function markImageInputUnsupported(model: Model<Api>): boolean {
	const key = modelKey(model);
	if (imageInputUnsupported.has(key)) return false;
	imageInputUnsupported.add(key);
	return true;
}

/** Drop all runtime downgrades. Intended for tests. */
export function clearImageInputDowngrades(): void {
	imageInputUnsupported.clear();
}

// Endpoints phrase this differently; keep the patterns tight enough that an
// unrelated failure mentioning images does not silently disable vision.
const IMAGE_INPUT_UNSUPPORTED_PATTERNS = [
	/image input is not supported/i,
	/image_url is only supported by certain models/i,
	/(?:does not|doesn't|do not|don't) support (?:image|vision|multimodal)/i,
	/(?:image|vision|multimodal) (?:input |content )?(?:is |are )?not supported/i,
];

/** True when a provider error message says the endpoint cannot accept image input. */
export function isImageInputUnsupportedError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return IMAGE_INPUT_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/** True when any user or tool result message carries an image block. */
export function hasImageContent(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user") {
			return Array.isArray(msg.content) && msg.content.some((block) => block.type === "image");
		}
		if (msg.role === "toolResult") {
			return Array.isArray(msg.content) && msg.content.some((block) => block.type === "image");
		}
		return false;
	});
}
