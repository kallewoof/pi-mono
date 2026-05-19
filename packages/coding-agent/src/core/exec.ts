/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Tail-and-write a diagnostic record when a stdout/stderr concatenation
 * overflows V8's max string length (~512 MB). Synchronous so the buffers
 * are still in scope when the host's uncaughtException handler runs.
 */
function writeExecFailureDump(
	command: string,
	args: string[],
	cwd: string,
	stdout: string,
	stderr: string,
	stream: "stdout" | "stderr",
	error: unknown,
): void {
	const TAIL_BYTES = 64 * 1024;
	const tail = (s: string): string => (s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s);
	const record = {
		kind: "execCommand-overflow",
		timestamp: new Date().toISOString(),
		command,
		args,
		cwd,
		overflowedStream: stream,
		stdoutLen: stdout.length,
		stderrLen: stderr.length,
		stdoutTail: tail(stdout),
		stderrTail: tail(stderr),
		error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
	};
	try {
		writeFileSync(resolvePath(process.cwd(), "failure.json"), JSON.stringify(record, null, 2));
	} catch {
		// Best-effort: if even the dump fails, let the rethrow surface upstream.
	}
}

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
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
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
		let timeoutId: NodeJS.Timeout | undefined;

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

		proc.stdout?.on("data", (data) => {
			try {
				stdout += data.toString();
			} catch (err) {
				writeExecFailureDump(command, args, cwd, stdout, stderr, "stdout", err);
				throw err;
			}
		});

		proc.stderr?.on("data", (data) => {
			try {
				stderr += data.toString();
			} catch (err) {
				writeExecFailureDump(command, args, cwd, stdout, stderr, "stderr", err);
				throw err;
			}
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
