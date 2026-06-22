import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

// Regression: a runaway child (e.g. a nested `pi --mode json` stuck in a loop)
// emitting more output than V8's max string length (2**29 - 1 ≈ 512 MB) used to
// crash the entire host with `RangeError: Invalid string length` thrown from the
// stream "data" handler as an uncaughtException. execCommand must instead cap the
// buffer, kill the producer, and resolve gracefully.
describe("execCommand output buffering", () => {
	it("truncates and kills a runaway producer instead of throwing", async () => {
		const maxBuffer = 64 * 1024; // tiny cap so the test stays fast
		// Emit ~16 MB in 64 KB chunks on a tight loop; far exceeds maxBuffer.
		const script =
			"const c='x'.repeat(64*1024);" +
			"let n=0;" +
			"const t=setInterval(()=>{process.stdout.write(c);if(++n>256)clearInterval(t);},0);";

		const result = await execCommand(process.execPath, ["-e", script], process.cwd(), { maxBuffer });

		expect(result.truncated).toBe(true);
		expect(result.killed).toBe(true);
		// Buffer is bounded to maxBuffer plus the appended truncation marker.
		expect(result.stdout.length).toBeLessThanOrEqual(maxBuffer + 128);
		expect(result.stdout).toContain("[output truncated");
	});

	it("leaves normal output untouched and does not flag truncation", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.stdout.write('hello world')"], process.cwd());

		expect(result.code).toBe(0);
		expect(result.truncated).toBeFalsy();
		expect(result.stdout).toBe("hello world");
		expect(result.stdout).not.toContain("[output truncated");
	});
});
