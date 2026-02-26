import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import fs from "fs"
import path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | "brainstorming"
  | "refining"
  | "dispatching"
  | "reviewing"
  | "reporting"
  | "complete"

interface PipelineState {
  phase: Phase
  iterations: number
  gitDiffCalled: boolean
  isGitRepo: boolean | null // null = not yet detected (lazy)
  startTime: number
  dispatches: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORCHESTRATOR_AGENT = "orchestrator"
const MAX_ITERATIONS = 3

/** Valid transitions: current phase -> set of allowed target phases */
const TRANSITIONS: Record<Phase, Phase[]> = {
  brainstorming: ["refining"],
  refining: ["dispatching"],
  dispatching: [], // auto-advance only (Task completion)
  reviewing: ["dispatching", "reporting"], // dispatching = iterate
  reporting: ["complete"],
  complete: [], // auto-reset only (new chat.message)
}

/** Human-readable target names the model uses -> actual phase */
const TARGET_ALIASES: Record<string, Phase> = {
  refine: "refining",
  dispatch: "dispatching",
  iterate: "dispatching", // reviewing -> dispatching is "iterate"
  report: "reporting",
  complete: "complete",
}

/** Guidance returned to the model after advancing to a new phase */
const PHASE_GUIDANCE: Record<Phase, string> = {
  brainstorming:
    "New request received. Load the brainstorming skill and explore context with the user. Ask clarifying questions, propose approaches, and get design approval before advancing. Call pipeline_advance('refine') when the user approves the design.",
  refining:
    "Transform the approved design into a precise implementation spec for brir-implementer. Include: files to modify/create (absolute paths), code patterns, expected behavior, test expectations, what NOT to change, and validation commands. Show the spec to the user and ask for approval. Call pipeline_advance('dispatch') when approved.",
  dispatching:
    "Dispatch the refined spec to brir-implementer via the Task tool. Include the full spec, relevant file contents, success criteria, and validation commands. The pipeline will auto-advance to reviewing when the task completes.",
  reviewing:
    "Review the implementation. You MUST run `git diff` to see all changes. Read modified files and evaluate against the approved design. Check for bugs, logic errors, missed edge cases, convention violations, and security concerns. Call pipeline_advance('report') when satisfied, or pipeline_advance('iterate') to re-dispatch with fixes.",
  reporting:
    "Provide a concise summary: what changed and why, files modified (with line references), review status (approved / approved with caveats), and any remaining concerns or follow-ups. Call pipeline_advance('complete') when done.",
  complete:
    "Pipeline complete. Waiting for next user request.",
}

/** Review guidance when NOT in a git repo */
const REVIEWING_NO_GIT =
  "Review the implementation. This directory is NOT a git repository, so skip `git diff`. Instead, Read each modified file directly and verify the changes match the approved design. Check for bugs, logic errors, missed edge cases, convention violations, and security concerns. Call pipeline_advance('report') when satisfied, or pipeline_advance('iterate') to re-dispatch with fixes."

/**
 * Tools the implementer (subagent) is allowed to call.
 * Everything else (MCP tools like nudge, sessiongraph, context7, playwright,
 * chrome-devtools) is blocked to reduce noise and prevent model confusion.
 * Checked case-insensitively.
 */
const SUBAGENT_ALLOWED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
  "todo",
  "todowrite",
  "question",
  "invalid",
  "apply_patch",
  // Plugin tools -- return graceful errors for non-orchestrator sessions
  "pipeline_advance",
  "pipeline_status",
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): PipelineState {
  return {
    phase: "brainstorming",
    iterations: 0,
    gitDiffCalled: false,
    isGitRepo: null,
    startTime: Date.now(),
    dispatches: 0,
  }
}

/** Check if a directory is inside a git repository */
function checkGitRepo(directory: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: directory,
      stdio: "pipe",
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}

/** Get phase guidance, accounting for non-git repos */
function getPhaseGuidance(phase: Phase, state: PipelineState): string {
  if (phase === "reviewing" && state.isGitRepo === false) {
    return REVIEWING_NO_GIT
  }
  return PHASE_GUIDANCE[phase]
}

function formatStatus(state: PipelineState): string {
  const valid = TRANSITIONS[state.phase]
    .map((p) => {
      for (const [alias, target] of Object.entries(TARGET_ALIASES)) {
        if (target === p) {
          if (state.phase === "reviewing" && p === "dispatching") return "iterate"
          return alias
        }
      }
      return p
    })

  const gitLabel =
    state.isGitRepo === false
      ? "n/a (not a git repo)"
      : state.gitDiffCalled
        ? "done"
        : "needed"

  const parts = [
    `Phase: ${state.phase}`,
    `Iteration: ${state.iterations}/${MAX_ITERATIONS}`,
    `git diff: ${gitLabel}`,
    `Dispatches: ${state.dispatches}`,
    `Valid transitions: ${valid.length > 0 ? valid.join(", ") : "(none -- automatic)"}`,
  ]
  return parts.join(" | ")
}

function statusBanner(state: PipelineState): string {
  const valid = TRANSITIONS[state.phase]
    .map((p) => {
      for (const [alias, target] of Object.entries(TARGET_ALIASES)) {
        if (target === p) {
          if (state.phase === "reviewing" && p === "dispatching") return "iterate"
          return alias
        }
      }
      return p
    })

  const gitLabel =
    state.isGitRepo === false
      ? "n/a"
      : state.gitDiffCalled
        ? "done"
        : "needed"

  return `[Pipeline: ${state.phase} | iter ${state.iterations}/${MAX_ITERATIONS} | git diff: ${gitLabel} | next: ${valid.join(", ") || "auto"}]`
}

// ---------------------------------------------------------------------------
// Unified diff patch parsing and application
// ---------------------------------------------------------------------------

interface PatchHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

interface PatchFile {
  oldPath: string
  newPath: string
  hunks: PatchHunk[]
}

/** Strip git-style a/ or b/ prefix and resolve to absolute path */
function resolvePatchPath(patchPath: string, baseDir: string): string {
  let cleaned = patchPath
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) {
    cleaned = cleaned.slice(2)
  }
  if (path.isAbsolute(cleaned)) return cleaned
  return path.resolve(baseDir, cleaned)
}

/** Parse a unified diff string into structured file/hunk data */
function parsePatch(patchText: string): PatchFile[] {
  const files: PatchFile[] = []
  const lines = patchText.split("\n")
  let currentFile: PatchFile | null = null
  let currentHunk: PatchHunk | null = null

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      currentFile = {
        oldPath: line.slice(4).trim(),
        newPath: "",
        hunks: [],
      }
      currentHunk = null
    } else if (line.startsWith("+++ ")) {
      if (currentFile) {
        currentFile.newPath = line.slice(4).trim()
        files.push(currentFile)
      }
    } else if (line.startsWith("@@ ")) {
      const match = line.match(
        /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      )
      if (match && currentFile) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
          lines: [],
        }
        currentFile.hunks.push(currentHunk)
      }
    } else if (currentHunk) {
      if (
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ")
      ) {
        currentHunk.lines.push(line)
      } else if (line === "\\ No newline at end of file") {
        // Ignore -- we normalize line endings anyway
      }
    }
  }

  return files
}

/**
 * Apply parsed hunks to file content.
 * Hunks are applied in reverse order (bottom-to-top) so earlier hunks
 * don't shift line numbers for later ones.
 */
function applyHunks(content: string, hunks: PatchHunk[]): string {
  const fileLines = content.split("\n")
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart)

  for (const hunk of sorted) {
    const removeLines: string[] = []
    const addLines: string[] = []
    let contextAndRemoveCount = 0

    for (const line of hunk.lines) {
      const prefix = line[0]
      const text = line.slice(1)
      if (prefix === "-") {
        removeLines.push(text)
        contextAndRemoveCount++
      } else if (prefix === "+") {
        addLines.push(text)
      } else if (prefix === " ") {
        removeLines.push(text)
        addLines.push(text)
        contextAndRemoveCount++
      }
    }

    const startIdx = hunk.oldStart - 1
    fileLines.splice(startIdx, contextAndRemoveCount, ...addLines)
  }

  return fileLines.join("\n")
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PipelineEnforcer: Plugin = async ({ client }) => {
  /** Per-session pipeline state. Only populated for orchestrator sessions. */
  const sessions = new Map<string, PipelineState>()

  /**
   * SessionIDs of known primary agents (orchestrator, plan, build, etc.).
   * Populated in `chat.message` which provides the `agent` field.
   * Any sessionID NOT in this set that triggers `tool.execute.before` is
   * treated as a subagent session and has MCP tools blocked.
   *
   * This replaces the broken `client.session.get()` parentID approach —
   * the SDK doesn't expose parentID in the response.
   */
  const knownPrimarySessions = new Set<string>()

  /** Lazily detect git repo status on first custom tool call */
  function ensureGitRepoDetected(
    state: PipelineState,
    directory: string
  ): void {
    if (state.isGitRepo === null) {
      state.isGitRepo = checkGitRepo(directory)
    }
  }

  // -------------------------------------------------------------------------
  // Custom tools
  // -------------------------------------------------------------------------

  const pipelineAdvance = tool({
    description:
      "Advance the BRIR pipeline to the next phase. Valid targets depend on the current phase. Returns guidance for the new phase or an error if the transition is invalid.",
    args: {
      target: tool.schema.enum(["refine", "dispatch", "iterate", "report", "complete"]),
    },
    async execute(args, ctx) {
      const state = sessions.get(ctx.sessionID)
      if (!state) {
        return "ERROR: No pipeline state for this session. This tool is only available to the orchestrator agent."
      }

      // Lazy git repo detection
      ensureGitRepoDetected(state, ctx.directory)

      const targetPhase = TARGET_ALIASES[args.target]
      if (!targetPhase) {
        return `ERROR: Unknown target '${args.target}'. Valid targets: ${Object.keys(TARGET_ALIASES).join(", ")}`
      }

      const allowed = TRANSITIONS[state.phase]
      if (!allowed.includes(targetPhase)) {
        const aliasNames = allowed.map((p) => {
          if (state.phase === "reviewing" && p === "dispatching") return "iterate"
          for (const [alias, target] of Object.entries(TARGET_ALIASES)) {
            if (target === p && alias !== "iterate") return alias
          }
          return p
        })
        return `ERROR: Cannot transition from '${state.phase}' to '${args.target}'. Valid transitions from '${state.phase}': ${aliasNames.length > 0 ? aliasNames.join(", ") : "(none -- transitions are automatic)"}`
      }

      // --- Prerequisite checks ---

      // iterate: must be under max iterations
      if (args.target === "iterate") {
        if (state.iterations >= MAX_ITERATIONS) {
          return `ERROR: Maximum iterations (${MAX_ITERATIONS}) reached. You must proceed to 'report' instead. Note any remaining issues as caveats.`
        }
        state.gitDiffCalled = false
        state.iterations++
        state.dispatches++
        state.phase = "dispatching"

        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: `Phase: reviewing -> dispatching (iterate #${state.iterations})`,
            extra: { sessionID: ctx.sessionID, iteration: state.iterations },
          },
        })

        return `Advanced to DISPATCHING (iteration ${state.iterations}/${MAX_ITERATIONS}). ${PHASE_GUIDANCE.dispatching}`
      }

      // report: must have called git diff (only enforced in git repos)
      if (args.target === "report") {
        if (!state.gitDiffCalled && state.isGitRepo !== false) {
          return "ERROR: You must run `git diff` before advancing to report. This ensures you have reviewed all changes."
        }
      }

      // --- Execute transition ---
      const previousPhase = state.phase
      state.phase = targetPhase

      if (targetPhase === "dispatching") {
        state.dispatches++
      }

      await client.app.log({
        body: {
          service: "pipeline-enforcer",
          level: "info",
          message: `Phase: ${previousPhase} -> ${targetPhase}`,
          extra: { sessionID: ctx.sessionID, iteration: state.iterations },
        },
      })

      if (targetPhase === "complete") {
        const elapsed = Math.round((Date.now() - state.startTime) / 1000)
        await client.tui.showToast({
          body: {
            message: `Pipeline complete: ${state.dispatches} dispatch(es), ${state.iterations} review cycle(s), ${elapsed}s`,
            variant: "success",
          },
        })
      }

      return `Advanced to ${targetPhase.toUpperCase()}. ${getPhaseGuidance(targetPhase, state)}`
    },
  })

  const pipelineStatus = tool({
    description:
      "Check the current pipeline phase, prerequisites, and valid transitions. Use this to understand where you are in the BRIR pipeline.",
    args: {},
    async execute(_args, ctx) {
      const state = sessions.get(ctx.sessionID)
      if (!state) {
        return "No pipeline state for this session. This tool is only available to the orchestrator agent."
      }

      ensureGitRepoDetected(state, ctx.directory)

      return `${formatStatus(state)}\n\nCurrent phase guidance: ${getPhaseGuidance(state.phase, state)}`
    },
  })

  // -------------------------------------------------------------------------
  // apply_patch tool -- compatibility shim for Codex-trained models
  // -------------------------------------------------------------------------

  const applyPatch = tool({
    description:
      "Apply a unified diff patch to create or modify files. Accepts standard unified diff format (like git diff output). Supports creating new files, modifying existing files, and multi-file patches.",
    args: {
      patch: tool.schema.string(),
    },
    async execute(args, ctx) {
      try {
        const files = parsePatch(args.patch)
        if (files.length === 0) {
          return (
            "ERROR: Could not parse any file changes from the patch. " +
            "Make sure the patch is in unified diff format with --- and +++ headers. " +
            "Alternatively, use the Write tool (to create files) or Edit tool (to modify files)."
          )
        }

        const results: string[] = []

        for (const file of files) {
          const filePath = resolvePatchPath(file.newPath, ctx.directory)

          if (
            file.oldPath === "/dev/null" ||
            file.oldPath === "a//dev/null" ||
            file.oldPath.endsWith("/dev/null")
          ) {
            const newContent = file.hunks
              .flatMap((h) =>
                h.lines
                  .filter((l) => l.startsWith("+"))
                  .map((l) => l.slice(1))
              )
              .join("\n")
            const dir = path.dirname(filePath)
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(filePath, newContent)
            results.push(`Created: ${filePath}`)
          } else if (
            file.newPath === "/dev/null" ||
            file.newPath === "b//dev/null" ||
            file.newPath.endsWith("/dev/null")
          ) {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath)
              results.push(`Deleted: ${filePath}`)
            } else {
              results.push(`Skipped (already gone): ${filePath}`)
            }
          } else {
            if (!fs.existsSync(filePath)) {
              return `ERROR: File not found: ${filePath}. Use --- /dev/null for new file creation.`
            }
            const original = fs.readFileSync(filePath, "utf8")
            const modified = applyHunks(original, file.hunks)
            fs.writeFileSync(filePath, modified)
            results.push(`Modified: ${filePath}`)
          }
        }

        return `Patch applied successfully:\n${results.join("\n")}`
      } catch (err: any) {
        return (
          `ERROR applying patch: ${err.message}\n\n` +
          `You can also use the Write tool (for new/full files) or Edit tool (for string replacements) instead.`
        )
      }
    },
  })

  // -------------------------------------------------------------------------
  // Hook implementations
  // -------------------------------------------------------------------------

  return {
    tool: {
      pipeline_advance: pipelineAdvance,
      pipeline_status: pipelineStatus,
      apply_patch: applyPatch,
    },

    // -- Initialize pipeline state & track primary sessions -----------------
    "chat.message": async (input) => {
      // Track ALL primary agent sessions for subagent detection.
      // chat.message only fires for user-initiated messages, which means
      // subagent sessions (spawned by Task tool) never appear here.
      // Any sessionID not in this set during tool.execute.before = subagent.
      if (input.agent && input.sessionID) {
        knownPrimarySessions.add(input.sessionID)
      }

      if (input.agent !== ORCHESTRATOR_AGENT) return

      const existing = sessions.get(input.sessionID)
      if (!existing) {
        sessions.set(input.sessionID, freshState())
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: "Pipeline initialized: brainstorming",
            extra: { sessionID: input.sessionID, agent: input.agent },
          },
        })
        return
      }

      if (existing.phase === "complete") {
        sessions.set(input.sessionID, freshState())
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: "Pipeline reset: complete -> brainstorming (new user message)",
            extra: { sessionID: input.sessionID },
          },
        })
      }
    },

    // -- Guard tools based on phase / block MCP noise in subagents ----------
    "tool.execute.before": async (input, output) => {
      const state = sessions.get(input.sessionID)

      // --- Subagent tool blocking ---
      // If this sessionID was never seen in chat.message, it's a subagent.
      // Block MCP tools that confuse the implementer model.
      if (!knownPrimarySessions.has(input.sessionID)) {
        const toolLower = input.tool.toLowerCase()
        if (!SUBAGENT_ALLOWED_TOOLS.has(toolLower)) {
          await client.app.log({
            body: {
              service: "pipeline-enforcer",
              level: "info",
              message: `Blocked MCP tool in subagent session: ${input.tool}`,
              extra: { sessionID: input.sessionID },
            },
          })
          throw new Error(
            `Tool '${input.tool}' is not available in implementation sessions. ` +
            `Use Read, Write, Edit, Bash, Glob, Grep, TodoWrite, or apply_patch for your work.`
          )
        }
        return
      }

      // --- Orchestrator phase guards (only apply if this session has pipeline state) ---
      if (!state) return

      const toolName = input.tool

      if (toolName === "task" || toolName === "Task") {
        if (state.phase !== "dispatching") {
          throw new Error(
            `BLOCKED: The Task tool can only be used during the 'dispatching' phase. ` +
            `Current phase: '${state.phase}'. ` +
            `Call pipeline_advance() to reach the dispatching phase first.`
          )
        }
      }

      if (toolName === "write" || toolName === "Write") {
        throw new Error(
          "BLOCKED: The orchestrator must not write files directly. All code changes go through brir-implementer via the Task tool."
        )
      }
      if (toolName === "edit" || toolName === "Edit") {
        throw new Error(
          "BLOCKED: The orchestrator must not edit files directly. All code changes go through brir-implementer via the Task tool."
        )
      }
    },

    // -- Track tool completions (git diff, Task) ---------------------------
    "tool.execute.after": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (!state) return

      const toolName = input.tool

      if (
        (toolName === "bash" || toolName === "Bash") &&
        state.phase === "reviewing"
      ) {
        const command = input.args?.command ?? input.args?.cmd ?? ""
        if (typeof command === "string" && command.trimStart().startsWith("git diff")) {
          state.gitDiffCalled = true
          await client.app.log({
            body: {
              service: "pipeline-enforcer",
              level: "info",
              message: "git diff detected during review",
              extra: { sessionID: input.sessionID, command },
            },
          })
        }
      }

      if (
        (toolName === "task" || toolName === "Task") &&
        state.phase === "dispatching"
      ) {
        const taskOutput = output.output ?? ""
        const failureMarkers = [
          "Task failed",
          "TASK_FAILED",
          "task was aborted",
          "agent crashed",
        ]
        const isFailed = failureMarkers.some((marker) =>
          taskOutput.includes(marker)
        )

        if (isFailed) {
          await client.app.log({
            body: {
              service: "pipeline-enforcer",
              level: "warn",
              message:
                "Task tool returned possible failure -- staying in dispatching phase",
              extra: {
                sessionID: input.sessionID,
                outputPreview: taskOutput.slice(0, 200),
              },
            },
          })
          return
        }

        state.phase = "reviewing"
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: "Phase: dispatching -> reviewing (auto-advance on Task completion)",
            extra: { sessionID: input.sessionID },
          },
        })
      }
    },

    // -- Inject phase status into system prompt (every turn) ---------------
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return

      const gitNote =
        state.isGitRepo === false
          ? " This is NOT a git repo -- skip git diff and verify changes by reading files directly."
          : ""

      output.system.push(
        `\n${statusBanner(state)}\n` +
        `You MUST call pipeline_advance() to transition between phases. ` +
        `You MUST call pipeline_status() if you are unsure where you are. ` +
        `The Task tool is ONLY available during the dispatching phase.` +
        gitNote
      )
    },

    // -- Inject phase context during compaction ----------------------------
    "experimental.session.compacting": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (!state) return

      output.context.push(
        `PIPELINE STATE (preserve this):\n` +
        `- Phase: ${state.phase}\n` +
        `- Iteration: ${state.iterations}/${MAX_ITERATIONS}\n` +
        `- git diff called this cycle: ${state.gitDiffCalled}\n` +
        `- Is git repo: ${state.isGitRepo ?? "unknown"}\n` +
        `- Total dispatches: ${state.dispatches}\n` +
        `- Elapsed: ${Math.round((Date.now() - state.startTime) / 1000)}s\n` +
        `- Current guidance: ${getPhaseGuidance(state.phase, state)}`
      )
    },

    // -- Observability (absorbed from workflow-logger) ---------------------
    event: async ({ event }) => {
      const props = event.properties ?? {}

      if (event.type === "session.error") {
        const sessionID = String(props.id ?? props.sessionID ?? "unknown")
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "error",
            message: "Session error in pipeline",
            extra: {
              sessionID,
              error: props.error,
            },
          },
        })
      }
    },
  }
}
