# System Prompt Handling in pi-coding-agent

## Entry point

`buildSystemPrompt()` in `packages/coding-agent/src/core/system-prompt.ts` assembles the final string. It is called by `AgentSession._rebuildSystemPrompt()` in `src/core/agent-session.ts`, which stores the result in `_baseSystemPrompt` and pushes it to `agent.state.systemPrompt`.

## When the prompt is (re)built

- On session start (via `setActiveToolsByName()` → `_rebuildSystemPrompt()`)
- Whenever the active tool set changes
- When an extension is loaded at runtime (calls `_rebuildSystemPrompt()` directly)

Between rebuilds the stored `_baseSystemPrompt` is reused. Per-turn modifications by extensions are applied on top of it each turn and then discarded — the base is restored if no extension modifies it.

## Inputs to buildSystemPrompt

| Input | Source |
|---|---|
| `customPrompt` | `ResourceLoader.getSystemPrompt()` — resolved from `<cwd>/.pi/SYSTEM.md` → `~/.pi/agent/SYSTEM.md` → `undefined` |
| `appendSystemPrompt` | `ResourceLoader.getAppendSystemPrompt()` — resolved from `<cwd>/.pi/APPEND_SYSTEM.md` → `~/.pi/agent/APPEND_SYSTEM.md` |
| `contextFiles` | `ResourceLoader.getAgentsFiles()` — `AGENTS.md`/`CLAUDE.md` files walked from filesystem root up to cwd, plus the global agent dir |
| `skills` | `ResourceLoader.getSkills()` — loaded from `~/.pi/agent/skills/` and `<cwd>/.pi/skills/` |
| `selectedTools` | Active tool names (default: `read`, `bash`, `edit`, `write`) |
| `toolSnippets` | Per-tool one-line descriptions from each tool's `promptSnippet` field |
| `promptGuidelines` | Per-tool bullet strings from each tool's `promptGuidelines` field |
| `cwd` | Session working directory |

## Assembly order

### Without customPrompt (default)

1. Hardcoded intro: `"You are an expert coding assistant operating inside pi…"`
2. **Available tools** section — only tools that have a `promptSnippet` are listed
3. Generic tools note ("you may have access to other custom tools…")
4. **Guidelines** section — built adaptively:
   - File exploration guideline based on which of `bash`/`grep`/`find`/`ls` are active
   - Additional bullets from `promptGuidelines` (tool-contributed)
   - Always appended: "Be concise in your responses" + "Show file paths clearly when working with files"
5. Pi documentation reference block (hardcoded paths to README, docs/, examples/)
6. `appendSystemPrompt` content (if any)
7. **Project Context** section — each `contextFiles` entry as `## <path>\n\n<content>`
8. **Skills** section (only if `read` tool is active) — XML per agentskills.io standard
9. `Current date: YYYY-MM-DD` (computed fresh each build)
10. `Current working directory: <cwd>`

### With customPrompt

Steps 1–5 are replaced entirely by the custom text. Steps 6–10 still apply in the same order.

## Context file loading (`AGENTS.md` / `CLAUDE.md`)

`loadProjectContextFiles()` (`resource-loader.ts:76`) walks the filesystem:

1. Global agent dir (`~/.pi/agent/`) — first candidate checked: `AGENTS.md`, fallback `CLAUDE.md`
2. Ancestor directories from `/` up to `cwd` (collected in order, root-first, so closer directories override further ones)

Files are deduplicated by path. All found files are injected under the **Project Context** heading.

## Skills in the prompt

`formatSkillsForPrompt()` (`skills.ts:339`) emits XML:

```xml
<available_skills>
  <skill>
    <name>…</name>
    <description>…</description>
    <location>/absolute/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

Skills with `disable-model-invocation: true` in their frontmatter are excluded (they are only invocable via `/skill:name`). The model is instructed to `read` the skill file when the task matches and to resolve relative paths against the skill's directory.

## Per-turn extension modification

Before each LLM call, `AgentSession.prompt()` calls `extensionRunner.emitBeforeAgentStart(userText, images, _baseSystemPrompt)`. Extensions register a `before_agent_start` handler that receives:

```ts
{ type: "before_agent_start", prompt: string, images: ImageContent[] | undefined, systemPrompt: string }
```

Handlers run in registration order; each receives the prompt as modified by the previous handler (`currentSystemPrompt` is threaded through). If any handler returns a `systemPrompt` field, that value replaces `agent.state.systemPrompt` for this turn only. On the next turn `_baseSystemPrompt` is restored unless a handler modifies it again.

## Compaction

Compaction summarises conversation history (messages). It does not touch the system prompt. `_baseSystemPrompt` is unchanged before and after compaction.

## Overrides available to SDK callers

`DefaultResourceLoader` accepts override callbacks for every input:

- `systemPromptOverride(base) → string | undefined`
- `appendSystemPromptOverride(base) → string[]`
- `agentsFilesOverride(base) → { agentsFiles }`
- `skillsOverride`, `extensionsOverride`, etc.

These allow programmatic SDK callers to inject or replace any part of the prompt without touching the filesystem.
