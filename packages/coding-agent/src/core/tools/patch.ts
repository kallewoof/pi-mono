import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/** The previous tool call that a `patch` call retries. */
export interface LastToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** Session-provided hooks the patch tool needs to reach the rest of the runtime. */
export interface PatchToolDeps {
	/** The most recent non-patch tool call, or undefined if none has run yet. */
	getLastToolCall(): LastToolCall | undefined;
	/** Resolve an active tool by name from the session registry. */
	resolveTool(name: string): AgentTool | undefined;
	/** Persist the merged arguments so successive patches accumulate onto the same call. */
	setLastToolArgs(args: Record<string, unknown>): void;
}

// Open object: the model may supply any subset of the previous tool's keys.
const patchSchema = Type.Object({}, { additionalProperties: true });

export type PatchToolInput = Static<typeof patchSchema>;

export interface PatchToolDetails {
	/** The tool the patch was applied to. */
	patchedTool: string;
}

/** Appended to a failed tool result (when patch is available) to advertise cheap retries. */
export const PATCH_RETRY_HINT =
	'You can retry this command by patching only the arguments that need to be fixed using patch({"fixed-key": "fixed-value"}). This reruns the previous tool call with these fields replaced; unspecified fields keep their previous values.';

/** True if any top-level argument serializes to more than `maxBytes` (default 50) bytes. */
export function hasLargeArgument(args: unknown, maxBytes = 50): boolean {
	if (!args || typeof args !== "object") {
		return false;
	}
	for (const value of Object.values(args as Record<string, unknown>)) {
		const serialized = typeof value === "string" ? value : JSON.stringify(value);
		if (serialized !== undefined && Buffer.byteLength(serialized, "utf-8") > maxBytes) {
			return true;
		}
	}
	return false;
}

const PATCH_DESCRIPTION = [
	"Retry the most recent tool call, replacing only the arguments you provide.",
	"Every key you pass here overwrites that key in the previous call; keys you omit keep their previous values.",
	"Use this after a tool fails because of a small mistake (wrong path, stray flag, typo) so you do not have to resend large arguments such as file contents.",
	"Arrays and objects are replaced wholesale, not merged element by element: to change one entry of an array argument you must resend the whole array.",
].join(" ");

export function createPatchToolDefinition(deps: PatchToolDeps): ToolDefinition<typeof patchSchema, PatchToolDetails> {
	return {
		name: "patch",
		label: "patch",
		description: PATCH_DESCRIPTION,
		promptSnippet: "Retry the previous tool call, changing only the given arguments",
		promptGuidelines: [
			"When a tool call fails only because of a small argument mistake, prefer patch({ key: fixedValue }) over resending the entire tool call.",
		],
		parameters: patchSchema,
		// Depends on which tool ran last; never run it concurrently with other calls.
		executionMode: "sequential",
		prepareArguments(input: unknown): PatchToolInput {
			// Some models send arguments as a JSON string instead of an object.
			if (typeof input === "string") {
				try {
					const parsed = JSON.parse(input);
					if (parsed && typeof parsed === "object") {
						return parsed as PatchToolInput;
					}
				} catch {}
			}
			return input as PatchToolInput;
		},
		async execute(toolCallId, params, signal, onUpdate) {
			const prev = deps.getLastToolCall();
			if (!prev) {
				throw new Error("Nothing to patch: no previous tool call has run yet in this turn.");
			}

			const tool = deps.resolveTool(prev.name);
			if (!tool) {
				throw new Error(`Cannot patch: the previous tool "${prev.name}" is no longer available.`);
			}

			const patchArgs = (params ?? {}) as Record<string, unknown>;
			let merged: Record<string, unknown> = { ...prev.args, ...patchArgs };

			// Mirror the agent loop: run the target tool's compatibility shim before validating.
			if (tool.prepareArguments) {
				merged = tool.prepareArguments(merged) as Record<string, unknown>;
			}

			const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: prev.name, arguments: merged };
			// Throws on invalid merged arguments; that error propagates as this call's failure.
			const validatedArgs = validateToolArguments(tool, toolCall);

			// Remember the merged arguments so a follow-up patch builds on this attempt.
			deps.setLastToolArgs(merged);

			const result = await tool.execute(toolCallId, validatedArgs, signal, onUpdate);
			const content: (TextContent | ImageContent)[] = result.content;
			return { content, details: { patchedTool: prev.name } };
		},
	};
}
