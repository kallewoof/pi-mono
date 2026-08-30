// Which APIs can carry a prefill — a trailing assistant message the model continues.
//
// Text prefill is broadly supported (Anthropic, OpenAI-compatible completions, Google), so it is
// left to the caller. Reasoning is different: only OpenAI-compatible completions endpoints accept
// replayable reasoning as a plain request field (`reasoning_content` and friends, which llama.cpp,
// DeepSeek and vLLM read back), so only they can be primed with one.

import type { Api, Model } from "../types.ts";

/**
 * True when a trailing assistant message on this model can carry a thinking prefill.
 *
 * Anthropic rejects any trailing assistant message while extended thinking is enabled, and the
 * Responses-style APIs carry reasoning as opaque signed items that cannot be synthesized, so
 * priming reasoning is only meaningful on OpenAI-compatible completions endpoints.
 */
export function modelAcceptsThinkingPrefill(model: Model<Api>): boolean {
	return model.api === "openai-completions";
}

/** Request field used to carry a thinking prefill on OpenAI-compatible completions endpoints. */
export const DEFAULT_THINKING_PREFILL_FIELD = "reasoning_content";
