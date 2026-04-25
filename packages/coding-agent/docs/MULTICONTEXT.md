# Multi-Context RPC Mode

RPC mode supports multiple independent conversation contexts within a single process. This allows a bridge application — for example, a messenger bot serving several groups or users — to share one `pi --mode rpc` process while keeping each conversation thread isolated.

## The Problem

A single RPC process has one default `AgentSession`. If a bridge forwards messages from different groups to the same process without distinguishing them, all groups share the same conversation history. That is almost never what you want.

The naive fix — one `pi --mode rpc` process per group — is wasteful. Multi-context support solves this: one process, N independent histories.

## How It Works

Every RPC command accepts an optional `"context"` string field. When present, the command targets a named context session instead of the default session. Named context sessions are:

- Created lazily on first use
- Backed by their own JSONL session file on disk
- Independent of one another and of the default session
- Automatically resumed across RPC restarts

Commands sent without `"context"` use the default session exactly as before; the feature is fully backward-compatible.

## Wire Protocol

### Commands

Add `"context": "<name>"` to any conversational command:

```json
{"type": "prompt", "message": "What's for dinner?", "context": "Family"}
{"type": "prompt", "message": "Review my notes", "context": "me"}
{"type": "get_state", "context": "Family"}
{"type": "abort", "context": "me"}
```

### Responses

The response echoes the `"context"` field so the bridge can correlate it:

```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "context": "Family"}
```

### Events

Events emitted by a named context session carry `"context"` in the JSON line:

```json
{"type": "agent_start", "context": "Family"}
{"type": "message_update", "message": {...}, "assistantMessageEvent": {...}, "context": "Family"}
{"type": "agent_end", "messages": [...], "context": "Family"}
```

Events from the default session (no `"context"` field) are unchanged.

## Context-Routed Commands

These commands are routed to the named session when `"context"` is present:

| Command | Notes |
|---------|-------|
| `prompt` | Sends message to the named context's conversation |
| `steer` | Steers the named context's running agent |
| `follow_up` | Queues a follow-up in the named context |
| `abort` | Aborts the named context's current operation |
| `get_state` | Returns state of the named context; includes `"context"` in `data` |
| `get_messages` | Returns messages from the named context |
| `get_session_stats` | Returns token/cost stats for the named context |
| `get_last_assistant_text` | Returns last assistant text from the named context |
| `compact` | Compacts the named context's history |
| `set_session_name` | Sets the display name of the named context's session |
| `new_session` | Replaces the named context with a fresh session |

All other commands (`set_model`, `bash`, `fork`, `switch_session`, `export_html`, etc.) always operate on the default session regardless of the `"context"` field.

## Persistence

Context name → session file mappings are persisted to:

```
~/.pi/agent/sessions/<encoded-cwd>/contexts.json
```

Example:
```json
{
  "Family": "/home/user/.pi/agent/sessions/--home-user-projects--/20250101_abc123.jsonl",
  "me": "/home/user/.pi/agent/sessions/--home-user-projects--/20250101_def456.jsonl"
}
```

On RPC restart, existing contexts are resumed automatically from this file. A context that is accessed before its session file has been written (e.g., immediately after `createIsolatedSession`) will be re-created on next use.

## Messenger Bridge Example

```python
import subprocess, json, threading

proc = subprocess.Popen(
    ["pi", "--mode", "rpc"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def handle_message(group_name: str, user_text: str):
    send({"type": "prompt", "message": user_text, "context": group_name})

def event_loop():
    for raw in proc.stdout:
        event = json.loads(raw)
        ctx = event.get("context", "<default>")
        if event.get("type") == "message_update":
            delta = event.get("assistantMessageEvent", {})
            if delta.get("type") == "text_delta":
                print(f"[{ctx}] {delta['delta']}", end="", flush=True)
        elif event.get("type") == "agent_end":
            print(f"\n[{ctx}] done")

threading.Thread(target=event_loop, daemon=True).start()

# Messages from different groups go to independent histories
handle_message("Family", "What should we have for dinner?")
handle_message("me",     "Summarize my TODO list")
handle_message("Work",   "What did we discuss yesterday?")
```

## TypeScript Client

The `RpcClient` class in `src/modes/rpc/rpc-client.ts` exposes `context?` on the relevant methods:

```typescript
import { RpcClient } from "@mariozechner/pi-coding-agent/rpc";

const client = new RpcClient({ cwd: "/my/project" });
await client.start();

// Each call targets an independent named session
await client.prompt("What's for dinner?", undefined, "Family");
await client.prompt("Review my TODO", undefined, "me");

// Events arrive tagged with their context
client.onEvent((event) => {
    if ("context" in event) {
        console.log(`[${event.context}]`, event);
    }
});

// Reset a single context without touching others
await client.newSession("Family");

// State is per-context
const state = await client.getState("Family");
console.log(state.context); // "Family"

await client.stop();
```

## Extension API

Extensions running on the main session can interact with named context sessions through three additions to the standard extension surface:

- **`ctx.context`** (`ExtensionContext`) — the name of the calling context session, or `undefined` for the main session. Tools and event handlers can read this to know which conversation invoked them.
- **`pi.sendUserMessageToContext(contextName, content, options?)`** — inject a user message into a named context session. Useful when an extension needs to *push* something into a conversation rather than *respond to* one (scheduled prompts, webhooks, file watchers).
- **`pi.sendMessageToContext(contextName, message, options?)`** — same semantics for custom (non-user) messages.

```typescript
pi.registerTool({
  name: "remind_me",
  // ...
  execute: async (_id, params, _signal, _onUpdate, ctx) => {
    // ctx.context is "Family" when called from the Family context session.
    schedule(params.when, () => {
      pi.sendUserMessageToContext(ctx.context!, params.prompt);
    });
    return "OK, I'll remind you.";
  },
});
```

These methods are no-ops outside multi-context RPC mode. See [extensions.md](extensions.md#ctxcontext) for the full extension API reference.

## Implementation Notes

Named context sessions are implemented as isolated `AgentSession` instances that live alongside the default session inside the same RPC process. They are created via `AgentSessionRuntime.createIsolatedSession()` or `AgentSessionRuntime.loadIsolatedSession()`, which call the same runtime factory as normal session creation but without tearing down or replacing the current default session. Each named session subscribes to agent events independently; the subscriber wraps every event with `{ ...event, context: contextName }` before writing it to stdout.
