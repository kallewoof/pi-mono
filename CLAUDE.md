# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

After code changes (not documentation changes), run the full check and fix all errors, warnings, and infos before committing:

```bash
npm run check          # Biome lint/format + tsc noEmit + browser smoke test (get full output, no tail)
```

Run a specific test file (from the package root, not the repo root):

```bash
cd packages/<pkg>
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

**NEVER run:** `npm run dev`, `npm run build`, `npm test` — these are reserved for the user.

Only run tests if the user instructs it, or if you create/modify a test file (in which case you MUST run it and iterate until it passes).

## Architecture

This is an npm-workspace monorepo with 7 packages. Build order matters; packages depend on each other in this layered architecture:

```
pi-tui          (terminal UI library, differential rendering)
pi-ai           (unified multi-provider LLM streaming API)
   └── pi-agent-core    (stateful agent runtime, event streaming, tool execution)
          └── pi-coding-agent   (CLI: interactive TUI, print, RPC, SDK modes)
          └── pi-mom            (Slack bot powered by pi-agent)
pi-web-ui       (web components for AI chat, uses pi-ai)
pi-pods         (CLI for managing vLLM GPU pod deployments)
```

### pi-ai

Provides a single `stream()` API across 20+ LLM providers (OpenAI, Anthropic, Google, Mistral, Groq, Bedrock, xAI, etc.). Providers are lazy-loaded via `packages/ai/src/providers/register-builtins.ts`. The unified event stream emits `text`, `tool_call`, `thinking`, `usage`, and `stop` events. Models are auto-generated via `scripts/generate-models.ts`.

Key files: `src/types.ts` (all API types), `src/providers/` (one file per provider), `src/env-api-keys.ts` (credential detection from env), `src/api-registry.ts` (provider registry).

### pi-agent-core

Wraps pi-ai with a stateful agent loop: tool execution, steering messages, thinking budgets, tool preflight hooks, and a transport abstraction for proxy backends.

### pi-coding-agent

Interactive coding agent CLI. Four built-in tools: `read`, `write`, `edit`, `bash`. Extensibility via TypeScript extensions, skills (installed CLIs), prompt templates, and themes. Sessions persist as JSONL in `~/.pi/sessions/` with branching and compaction support.

Key directories: `src/core/` (tools, extensions, skills, session, compaction), `src/modes/` (interactive TUI, RPC server), `src/cli/` (argument parsing).

### pi-tui

Terminal UI with differential rendering and CSI 2026 synchronized output. Components: Text, Input, Editor, Markdown, SelectList, SettingsList, Image, Box, Container. Supports Kitty/iTerm2 inline images and IME via Focusable interface.

## Code Quality Rules

- No `any` types unless absolutely necessary
- **No inline imports** — no `await import("./foo.js")`, no dynamic imports for types. Always use top-level imports.
- Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Never hardcode keybinding checks (e.g. `matchesKey(keyData, "ctrl+x")`). All keybindings must be configurable with defaults in `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`
- Check `node_modules` for external API type definitions instead of guessing

## Testing

- **Framework:** Vitest (all packages except tui which uses `node --test`)
- **Test locations:** `packages/<pkg>/test/`
- **Suite tests** (`packages/coding-agent/test/suite/`): Use `test/suite/harness.ts` plus the faux provider. Never use real provider APIs, real API keys, or paid tokens.
- **Regressions:** `packages/coding-agent/test/suite/regressions/<issue-number>-<short-slug>.test.ts`
- **Env flag:** `PI_NO_LOCAL_LLM=1` skips Ollama/LMStudio tests

### Testing pi TUI with tmux

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "cd /path/to/pi-mono && ./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape          # send Escape
tmux send-keys -t pi-test C-o             # send ctrl+o
tmux kill-session -t pi-test
```

## Adding a New LLM Provider

Changes required across 7 locations:

1. **`packages/ai/src/types.ts`** — Add to `Api` union, create options interface, add to `ApiOptionsMap`, add to `KnownProvider`
2. **`packages/ai/src/providers/<provider>.ts`** — Implement `stream<Provider>()` emitting unified events
3. **`packages/ai/package.json`** + **`src/index.ts`** + **`src/providers/register-builtins.ts`** — Export, lazy-register, add subpath export
4. **`packages/ai/src/env-api-keys.ts`** — Credential detection from env vars
5. **`packages/ai/scripts/generate-models.ts`** — Fetch/parse models from provider
6. **`packages/ai/test/`** — Add to all 11 test files: `stream`, `tokens`, `abort`, `empty`, `context-overflow`, `image-limits`, `unicode-surrogate`, `tool-call-without-result`, `image-tool-result`, `total-tokens`, `cross-provider-handoff`
7. **`packages/coding-agent/src/core/model-resolver.ts`** and `src/cli/args.ts` — Default model ID and env var docs

## Changelog

Each package has its own `CHANGELOG.md`. New entries always go under `## [Unreleased]`. Never modify released version sections.

Sections: `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, `### Removed`

Attribution format:
- Internal (from issue): `Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- External contribution: `Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## Git Rules (Critical for Parallel Agents)

Multiple agents may work on different files in the same worktree simultaneously.

- **ONLY commit files YOU changed in THIS session**
- ALWAYS use `git add <specific-file-paths>` — never `git add -A` or `git add .`
- Before committing, run `git status` and verify you are only staging your files
- Include `fixes #<number>` or `closes #<number>` in commit messages when there is a related issue/PR

**Forbidden operations** (can destroy other agents' work):
- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- `git add -A` / `git add .`
- `git commit --no-verify`

If a rebase conflict is in a file you didn't modify, abort and ask the user. Never force push.

## Versioning and Release

All packages share the same version (lockstep). No major releases:
- `patch`: bug fixes and new features
- `minor`: API breaking changes

Release: `npm run release:patch` or `npm run release:minor` (handles version bump, CHANGELOG, commit, tag, publish).

## PR Workflow

PRs from external contributors are analyzed without pulling locally first. If approved: create feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR. Never open PRs directly — work in feature branches then merge to main.

## Issue/PR Comments

- Write full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown via `--body` in shell commands
- Preview before posting; post exactly one final comment unless explicitly asked for multiple

## Formatting

Biome v2 is the formatter and linter (`npm run check` covers this). Configuration: tabs, width 3, line width 120. No `noNullAssertion` suppression, `useConst` is an error.

## Conversational Style

- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, kind but direct
