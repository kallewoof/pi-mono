import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PATCH_RETRY_HINT } from "../../src/core/tools/patch.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("patch tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("hints on large-argument failure and retries via patch, reusing the original content", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const largeContent = `${"x".repeat(500)}\nimportant original data\n`;
		// tempDir is an existing directory, so writing a file there fails (EISDIR).
		const badPath = harness.tempDir;
		const goodPath = join(harness.tempDir, "out.txt");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: badPath, content: largeContent })], {
				stopReason: "toolUse",
			}),
			// Fix only the path; content is intentionally omitted and must be reused from the failed call.
			fauxAssistantMessage([fauxToolCall("patch", { path: goodPath })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("write the file");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.length).toBe(2);

		// The failed write carried a large `content` argument, so the retry hint is appended.
		const failed = toolResults[0];
		expect(failed.role === "toolResult" && failed.isError).toBe(true);
		expect(getMessageText(failed)).toContain(PATCH_RETRY_HINT);

		// The patch succeeded by rerunning write with the merged arguments.
		const patched = toolResults[1];
		expect(patched.role === "toolResult" && patched.isError).toBe(false);

		// The file holds the original large content, proving the omitted argument was reused.
		expect(readFileSync(goodPath, "utf-8")).toBe(largeContent);
	});

	it("does not append the retry hint when the failing arguments are all small", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const badPath = harness.tempDir; // fails, but the arguments are short
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: badPath, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("write the file");

		const failed = harness.session.messages.find((message) => message.role === "toolResult");
		expect(failed?.role === "toolResult" && failed.isError).toBe(true);
		expect(getMessageText(failed)).not.toContain(PATCH_RETRY_HINT);
	});
});
