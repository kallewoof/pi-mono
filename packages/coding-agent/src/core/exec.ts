/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Default ceiling for captured stdout/stderr, in UTF-16 code units. A runaway
 * child (e.g. a nested `pi --mode json` stuck in a loop) can emit hundreds of
 * MB; concatenating past V8's max string length (2**29 - 1 ≈ 512 MB) throws
 * `RangeError: Invalid string length`. That throw used to escape the stream's
 * "data" handler as an uncaughtException and kill the whole host process. We
 * cap well below the limit so the host stays alive and the producer is killed.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 256 * 1024 * 1024;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Maximum captured characters per stream (stdout/stderr) before output is
	 * truncated and the child is killed. Defaults to {@link DEFAULT_MAX_OUTPUT_CHARS}.
	 */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** True if either stream hit `maxBuffer` and was truncated (child was killed). */
	truncated?: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let truncated = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_OUTPUT_CHARS;
		const TRUNCATION_MARKER = "\n[output truncated: exceeded maxBuffer; process killed]\n";

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		// Accumulate a chunk while keeping the buffer strictly under `maxBuffer`
		// (and thus under V8's max string length). On the first overflow we keep
		// the head, append a marker, flag truncation, and kill the child so a
		// runaway producer cannot keep streaming. Subsequent chunks are dropped.
		const appendBounded = (current: string, chunk: string): string => {
			if (truncated) return current;
			if (current.length + chunk.length <= maxBuffer) return current + chunk;
			const remaining = Math.max(0, maxBuffer - current.length);
			truncated = true;
			killProcess();
			return current + chunk.slice(0, remaining) + TRUNCATION_MARKER;
		};

		proc.stdout?.on("data", (data) => {
			stdout = appendBounded(stdout, data.toString());
		});

		proc.stderr?.on("data", (data) => {
			stderr = appendBounded(stderr, data.toString());
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed, truncated });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed, truncated });
			});
	});
}
