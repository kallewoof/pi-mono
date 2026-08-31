import { type Context, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/** Text of the trailing message of a captured request, empty unless it is an assistant message. */
function trailingText(messages: Message[] | undefined): string {
	const message = messages?.[messages.length - 1];
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("AgentSession prefill", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("primes the next prompt and merges the prefill into the recorded response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(" read the file first.");
			},
		]);

		harness.session.setPrefill("Plan:");
		await harness.session.prompt("what now?");

		expect(trailingText(requests[0])).toBe("Plan:");
		expect(getMessageText(harness.session.messages[1]!)).toBe("Plan: read the file first.");
		// One-shot: consumed by that prompt.
		expect(harness.session.getPrefill()).toBeUndefined();
	});

	it("does not prime a later prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		const capture = (context: Context) => {
			requests.push([...context.messages]);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([capture, capture]);

		harness.session.setPrefill("Plan:");
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(trailingText(requests[0])).toBe("Plan:");
		expect(requests[1]?.[requests[1].length - 1]?.role).toBe("user");
	});

	it("drops a reasoning prefill the model's API cannot carry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage("ok");
			},
		]);

		// The faux API is not an OpenAI-compatible completions endpoint, so there is nothing to
		// carry the reasoning and the request goes out unprimed rather than being rejected.
		harness.session.setPrefill({ thinking: "Consider the units first." });
		await harness.session.prompt("go");

		expect(requests[0]?.[requests[0].length - 1]?.role).toBe("user");
	});

	it("primes a message an extension sends through sendUserMessage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(" check the callers.");
			},
		]);

		await harness.session.sendUserMessage("run the scheduled job", { prefill: "First," });

		expect(trailingText(requests[0])).toBe("First,");
	});

	it("primes a message that had to be queued as a follow-up", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			async (context: Context) => {
				requests.push([...context.messages]);
				// Queue while the run is in flight — the run's own first request is long past
				// by the time this message is delivered.
				await harness.session.prompt("and then the other thing", {
					streamingBehavior: "followUp",
					prefill: "Then:",
				});
				return fauxAssistantMessage("first");
			},
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(" the other thing.");
			},
		]);

		await harness.session.prompt("do the thing");

		expect(requests).toHaveLength(2);
		// The run's first request is unprimed; the queued message primes the one it triggers.
		expect(requests[0]?.[requests[0].length - 1]?.role).toBe("user");
		expect(trailingText(requests[1])).toBe("Then:");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Then: the other thing.");
	});

	it("primes a message that had to be queued as steering", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			async (context: Context) => {
				requests.push([...context.messages]);
				await harness.session.prompt("actually, do it this way", {
					streamingBehavior: "steer",
					prefill: "Adjusting:",
				});
				return fauxAssistantMessage("first");
			},
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(" done.");
			},
		]);

		await harness.session.prompt("do the thing");

		expect(requests).toHaveLength(2);
		expect(trailingText(requests[1])).toBe("Adjusting:");
	});

	it("primes a queued message from a prefill armed with setPrefill", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			async (context: Context) => {
				requests.push([...context.messages]);
				harness.session.setPrefill("Armed:");
				await harness.session.prompt("queued", { streamingBehavior: "followUp" });
				return fauxAssistantMessage("first");
			},
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage(" ok");
			},
		]);

		await harness.session.prompt("do the thing");

		expect(trailingText(requests[1])).toBe("Armed:");
		// Consumed by the queued message, so it cannot leak into a later prompt.
		expect(harness.session.getPrefill()).toBeUndefined();
	});

	it("accepts a per-prompt prefill that overrides the armed one", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const requests: Message[][] = [];
		harness.setResponses([
			(context: Context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage("ok");
			},
		]);

		harness.session.setPrefill("Armed:");
		await harness.session.prompt("go", { prefill: "Explicit:" });

		expect(trailingText(requests[0])).toBe("Explicit:");
	});
});
