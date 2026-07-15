import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

/**
 * Reproduction: a `length` (output-token-limit) stop that happens because the INPUT
 * context nearly fills the window — leaving almost no room for output — is a genuine
 * context overflow, but `isContextOverflow` returns false for it.
 *
 * Case 3 of isContextOverflow only fires when `output === 0` AND
 * `input + cacheRead >= contextWindow * 0.99`. Real sessions hit the wall slightly
 * below 99% and with a tiny non-zero output (a partial tool call / one token of
 * reasoning before truncation), so neither sub-condition holds and the overflow is
 * missed — the agent then spins on truncated responses instead of compacting+retrying.
 *
 * `packages/ai/src/utils/overflow.ts` is byte-identical to upstream/main, so these
 * assertions describe upstream behavior too.
 */

function lengthStop(usage: { input: number; cacheRead: number; output: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "llamacpp",
		model: "llama-gemma4-flavorful:31b",
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: 0,
			totalTokens: usage.input + usage.cacheRead + usage.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "length",
		timestamp: Date.now(),
	};
}

const WINDOW = 131072;

describe("isContextOverflow: length stop under input-context pressure", () => {
	it("treats a length stop with a tiny non-zero output near the window as overflow (real-session numbers)", () => {
		// From the live session: input 5301 + cacheRead 122273 = 127574 (~97.3% of 131072), output 1.
		const message = lengthStop({ input: 5301, cacheRead: 122273, output: 1 });
		expect(isContextOverflow(message, WINDOW)).toBe(true);
	});

	it("treats a length stop at 97% of the window with output=0 as overflow", () => {
		// Below the current 99% threshold, but there is clearly no room to work.
		const message = lengthStop({ input: 0, cacheRead: Math.floor(WINDOW * 0.97), output: 0 });
		expect(isContextOverflow(message, WINDOW)).toBe(true);
	});

	it("does NOT treat a length stop with plenty of free context as overflow (long answer, healthy prefix)", () => {
		// Control: a normal long-output length stop with a small prefix must stay false.
		const message = lengthStop({ input: 2000, cacheRead: 3000, output: 4096 });
		expect(isContextOverflow(message, WINDOW)).toBe(false);
	});
});
