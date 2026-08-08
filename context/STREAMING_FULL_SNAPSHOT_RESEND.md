# Incident: dedicated subprocess killed by the 256MB output cap — not a timeout, not a loop

**Date:** 2026-07-20
**Where it surfaced:** `pi-schedule-prompt` (sibling fork in this workspace), but the root cause lives here in `pi-mono`.
**Status:** **RESOLVED UPSTREAM (v0.84.x)** — see "Resolution" at the bottom. Originally: diagnosed, not filed as an upstream issue, not started.

## What happened

A `pi-schedule-prompt` scheduled job (`pi --mode json -p ...`, a dedicated subprocess spawned by `CronScheduler.executeDedicatedJob`) was killed after ~7 minutes and reported as failed. The failure hint (before a same-day fix) claimed "subprocess hit the 60-minute timeout" — but the job's own real timeout is 60 minutes, and it died in under 7. Tracing `ExecResult.killed`/`truncated` down into `execCommand()` (`packages/coding-agent/src/core/exec.ts`) showed the real cause: the child's **stdout crossed the 256MB `maxBuffer` cap** (`DEFAULT_MAX_OUTPUT_CHARS`, `exec.ts:~16`, overridable per-call via `ExecOptions.maxBuffer`, `exec.ts:~32`/`~70`) and was killed by `killProcess()` for that reason, not by the `options.timeout` path.

The natural assumption — "a runaway/looping agent must have spammed duplicate output" — turned out to be wrong for this specific run. The captured (and human-rendered) transcript showed a completely ordinary, linear turn: read two files, one `web_search` call, then a single `edit` tool call rewriting a sizeable chunk of a markdown report — cut off mid-argument. No repetition anywhere in the visible transcript.

This looked contradictory (small, clean, non-repeating transcript vs. a 256MB kill) until we traced *how* that transcript was produced.

## Root cause: full-snapshot resend, not delta transmission

`pi --mode json`'s streaming protocol does **not** send incremental deltas over the JSON event stream. On every single token/delta during generation, it re-serializes and re-emits the **entire accumulated message so far** (all thinking so far + all text so far + the full in-progress tool-call argument so far), not just the newly-added piece:

- `packages/agent/src/agent-loop.ts` (~L337-345): on every `toolcall_delta` event, `partialMessage = event.partial` is reassigned to the full accumulated message, and that whole object is re-emitted as a `message_update` event.
- `packages/ai/src/api/anthropic-messages.ts` (~L647-650): `block.partialJson += event.delta.partial_json; block.arguments = parseStreamingJson(block.partialJson)` — the full JSON argument string is re-accumulated and **re-parsed from scratch** on every delta, not just appended.
- `packages/coding-agent/src/modes/print-mode.ts` (~L104): `writeRawStdout(JSON.stringify(event))` — writes that full growing snapshot to the child's stdout, **unthrottled, on every single delta**, with no coalescing (not by time, not by size, not only-on-`message_end`).

The consequence is quadratic growth in raw bytes written, in the length of whatever the model is currently generating. If a single logical message (thinking + text + one tool-call argument) ends up `L` bytes long and is streamed in delta chunks of roughly `c` bytes each, the total bytes written to stdout over the course of that one message is approximately:

```
sum_{i=1}^{L/c} (i * c)  ≈  L² / (2c)
```

This is **not new** — a pre-existing code comment in `pi-schedule-prompt/src/scheduler.ts` (`formatDedicatedRunOutput`) already documents an earlier instance of the same underlying issue: *"A single timed-out run with 5000+ thinking deltas produced 27 MB of duplicated `[thinking]` blocks"*. That comment's fix was purely defensive — collapsing the redundant snapshots back down to one final state **after the fact**, for storage/display — it does not address where the bytes came from in the first place.

In this incident, a single `edit` call rewriting a large chunk of a report (plausibly tens of KB of `newText`, generated as part of a reasoning-heavy turn with substantial preceding "thinking" content) was enough, once resent in full on every delta, to blow past 256MB of raw stdout before the edit even finished — with the model behaving completely normally the whole time. The clean, small, non-repeating transcript the user eventually saw is not evidence against this: `pi-schedule-prompt`'s own rendering step (`formatDedicatedRunOutput`) explicitly dedups/collapses the raw event stream down to just the final state of each logical message before display, exactly to hide this kind of redundant bloat from readers. A modest-looking final transcript and a genuine 256MB-of-raw-stream kill are fully consistent, not contradictory — the raw stream is simply never shown to anyone.

## What this is *not*

Ruled out during the investigation, in case it comes up again for a similar-looking incident:

- **The real 60-minute subprocess timeout** (`DEDICATED_JOB_TIMEOUT_MS` in `pi-schedule-prompt`) — the run died in ~7 minutes, nowhere close.
- **The `SUBPROCESS_STALE_MS` leaked-subprocess watchdog** in `pi-schedule-prompt` (~62 minutes) — same reason.
- **A session-shutdown-triggered abort** (`CronScheduler.stop({reason: "quit"})` aborting in-flight controllers) — ruled out because `notify()` in that codepath no-ops once `this.stopped` is true, which would have silently suppressed the very failure notification the user saw; the user also confirmed their session was up the entire time.
- **The context-overflow / clamped-max-tokens retry-loop bug** (`packages/ai/src/api/simple-options.ts` `CONTEXT_SAFETY_TOKENS`/`clampMaxTokensToContext`, `packages/ai/src/utils/overflow.ts`) that was fixed by commits `b5511fef` and `f4099417` (same author, 2026-07-15): that bug produced **many small, near-empty, repeatedly-retried tool calls** when a `length` stop reason crushed the remaining output budget near full context — a real bug, already fixed, but a different symptom signature (many small failed turns) than what this incident shows (one large, successful-looking, linear turn). It's also now bounded by a one-shot `_overflowRecoveryAttempted` guard in `agent-session.ts` (~L2019-2039) even if it recurred.
- **A deliberately small context window for the dedicated subprocess** — `pi-schedule-prompt/src/scheduler.ts` spawns `pi --mode json -p --session-dir ... <prompt>` with no `--model` flag, so it resolves whatever the ambient default model config is, same as an interactive session. Nothing forces a smaller context window for scheduled dedicated jobs specifically. (A real `contextWindow: 65536`-class model does exist in some provider catalogs, e.g. `packages/ai/src/providers/openrouter.models.ts`/`huggingface.models.ts` — if the ambient default model happens to be one of those, a context-pressure contribution isn't impossible in principle, but nothing here forces it, and the observed transcript doesn't show the overflow-retry signature described above.)

## Why "just raise the 256MB cap" is not a fix

`maxBuffer` is already overridable per-call (`ExecOptions.maxBuffer`, `exec.ts`), so a workaround is cheap to reach for from a consumer like `pi-schedule-prompt` without touching this repo at all. It was deliberately **not** applied there. Because the growth is quadratic in message length, doubling the real content that legitimately needs to stream (a bigger edit, a more reasoning-heavy turn) roughly *quadruples* the raw bytes — so any fixed cap is a losing race against the next moderately-larger-but-still-healthy turn, and raising it only buys a bit of headroom while increasing per-job buffered memory. It treats the symptom, not the cause.

## The actual fix (not yet started)

Somewhere in `agent-loop.ts` → `print-mode.ts` (and likely the interactive TUI's own event consumer, which needs auditing too), switch from "re-emit the full snapshot on every token" to one of:

1. **True delta transmission** — emit only the newly-added slice of thinking/text/tool-argument content per event, and let consumers accumulate it themselves. Correctness-sensitive: every current consumer of the JSON stream (interactive TUI rendering, `print-mode`, any extension parsing `pi --mode json` output, `pi-schedule-prompt`'s own `formatDedicatedRunOutput`) currently assumes it always receives a complete, self-consistent snapshot and would need updating to reassemble deltas instead.
2. **Throttled/coalesced snapshots** — keep full-snapshot semantics (simpler for consumers, no reassembly logic needed anywhere) but only actually emit/write one every N deltas, or only on `message_end`/`turn_end` plus a periodic heartbeat during long generations. Lower blast-radius than (1): no consumer-side reassembly changes needed, just less frequent (but still complete) snapshots. Loses truly live token-by-token rendering fidelity in the interactive TUI unless the in-memory render path is decoupled from the stdout-write path (worth checking whether `print-mode.ts`'s `writeRawStdout` throttling can be independent of whatever `interactive-mode.ts` does for live rendering).

Given this touches a core streaming protocol with multiple consumers across this monorepo, it deserves a dedicated investigation/plan of its own rather than a quick patch — this document exists so that investigation doesn't have to start from zero.

## Where the immediate (downstream) symptom was patched

Not here — in `pi-schedule-prompt`, as a stopgap that doesn't touch this repo:

- `detectFailureHint` (`pi-schedule-prompt/src/scheduler.ts`) no longer blames "the 60-minute timeout" for every `killed=true`; it now checks the actual recorded duration and the `ExecResult.truncated` flag, and for the output-cap case explains that it can come from either a real loop or a single large tool-call argument getting resent as a growing snapshot (this document's mechanism), with a short tail-of-output snippet appended so a reader can tell the two apart themselves.
- Commits: `8c6dbb0` (replay-id fix + initial cause-specific hint), `b73b382` (corrected the hint's wording after this specific incident showed the "almost certainly a loop" framing was overconfident).

That fix makes the symptom legible. It does not, and cannot, address the root cause described above — that has to happen here.

---

## Resolution (post-v0.84.4 rebase, 2026-08-29)

Upstream fixed the root cause, and took option (1) — real delta transmission — rather than the coalescing of option (2).

`packages/coding-agent/src/modes/json-event.ts` adds `toJsonEvent(event)`, which rewrites a `message_update` as `{ type, usage, assistantMessageEvent }` with the cumulative `partial` snapshot **stripped**. `message_start` carries the initial message and `message_end` the final authoritative one; everything in between is a delta. Both `print-mode` (json) and `rpc-mode` now route every event through it, so raw stdout volume is O(message length) rather than O(L²/2c). Its own doc comment states the intent directly: "Remove cumulative assistant snapshots from streaming wire events."

The fork had shipped option (2) as `fix(coding-agent): bound quadratic stdout growth in json/rpc streaming` (`stream-coalesce.ts`, a size-aware multiplicative gate). **That commit was dropped in the post-v0.84.4 rebase** — not merely as a duplicate, but because keeping it on top of the delta wire format would have been an active bug: with no cumulative snapshot to catch up from, a suppressed intermediate `message_update` loses that delta permanently.

Consumer-side consequence, worth knowing for `pi-signal-messenger` and `pi-schedule-prompt`: a `--mode json` / `--mode rpc` consumer that read the full message off `message_update` now sees deltas instead, and must accumulate (or just wait for `message_end`). The fork's per-context RPC subscriptions were updated to emit the same shape as the default session (`output({ ...toJsonEvent(event), context: contextName })`), so context and non-context events stay consistent.
