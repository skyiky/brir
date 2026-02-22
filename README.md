# BRIR

**B**rainstorm. **R**efine. **I**mplement. **R**eview.

A multi-agent pipeline for [OpenCode](https://opencode.ai) that separates thinking from doing. One agent designs and reviews. Another writes code. You approve the design before any code is written, and every implementation gets reviewed before you see it.

## How it works

The pipeline has four phases, run by two agents.

**Phase 0 — Brainstorm.** The orchestrator explores your codebase, asks clarifying questions, and proposes approaches with trade-offs. No code is written until you approve the design.

**Phase 1 — Refine.** The approved design is transformed into a precise implementation spec: file paths, code patterns to follow, expected behavior, edge cases, validation commands. This spec targets an AI coding agent, not a human developer.

**Phase 2 — Implement.** The spec is dispatched to a separate coding agent (GPT Codex by default) via OpenCode's Task tool. The implementer executes the spec, runs validation, and reports back.

**Phase 3 — Review.** The orchestrator reads the git diff, evaluates every change against the original design, and checks for bugs, missed edge cases, and convention violations. If issues are found, it sends targeted feedback back to the implementer. This cycle repeats up to three times before the orchestrator accepts with noted caveats.

When the pipeline completes, you get a summary of what changed, which files were modified, and any remaining concerns.

## What's included

```
.opencode/
├── agents/
│   ├── orchestrator.md        # Primary agent — designs, dispatches, reviews
│   └── codex-implementer.md   # Hidden subagent — writes code
├── plugins/
│   └── workflow-logger.ts     # Tracks dispatch count, review cycles, elapsed time
├── commands/
│   └── meta-build.md          # /meta-build command shortcut
└── package.json               # Plugin dependency
```

**Orchestrator** (`claude-opus-4.6` via GitHub Copilot): Read-only access to the codebase. Cannot write or edit files. Can run `git diff`, `git log`, `git status`, and `git show` for review. Can only dispatch tasks to the implementer.

**Implementer** (`gpt-5.2-codex` via GitHub Copilot): Full file access — read, write, edit, bash. No Task tool access (cannot spawn further agents). Hidden from the `@` autocomplete menu.

**Workflow logger**: A plugin that tracks how many times the implementer was dispatched, how many review cycles occurred, and shows a toast notification when the pipeline finishes.

## Install

Copy the `.opencode/` directory contents into your project:

```bash
# Clone this repo
git clone https://github.com/skyiky/brir.git

# Copy into your project's .opencode directory
cp -r brir/.opencode/agents/ your-project/.opencode/agents/
cp -r brir/.opencode/plugins/ your-project/.opencode/plugins/
cp -r brir/.opencode/commands/ your-project/.opencode/commands/
cp brir/.opencode/package.json your-project/.opencode/package.json
```

If you already have a `.opencode/package.json`, merge the `@opencode-ai/plugin` dependency into it.

Then restart OpenCode. The orchestrator appears as a primary agent alongside Build and Plan.

## Usage

**Tab** to the orchestrator agent, then type your prompt as usual. The pipeline starts automatically.

Or use the `/meta-build` command from any agent:

```
/meta-build Add a dark mode toggle to the settings page
```

Navigate between the orchestrator and implementer sessions with `Leader+Right` / `Leader+Left`.

## Models

The agents default to these models through the GitHub Copilot provider:

| Agent | Model |
|---|---|
| Orchestrator | `github-copilot/claude-opus-4.6` |
| Implementer | `github-copilot/gpt-5.2-codex` |

To use different models or providers, edit the `model:` field in each agent's markdown file. Run `opencode models` to see what's available through your configured providers.

```yaml
# .opencode/agents/orchestrator.md frontmatter
model: anthropic/claude-sonnet-4
```

## Superpowers integration

If you use OpenCode's [superpowers skills](https://github.com/anomalyco/opencode), the orchestrator integrates with the `brainstorming` skill for Phase 0. It loads the skill automatically before any design work begins.

The orchestrator's Refine phase replaces the `writing-plans` skill. Both serve the same purpose — turning an approved design into actionable steps — but the orchestrator's output targets a coding agent instead of a human.

## Requirements

- [OpenCode](https://opencode.ai) v1.2.10 or later
- A configured provider with access to both a reasoning model (orchestrator) and a coding model (implementer)

## License

Apache 2.0
