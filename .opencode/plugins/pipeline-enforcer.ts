import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

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
  startTime: number
  dispatches: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORCHESTRATOR_AGENT = "orchestrator"
const MAX_ITERATIONS = 3

/** Valid transitions: current phase → set of allowed target phases */
const TRANSITIONS: Record<Phase, Phase[]> = {
  brainstorming: ["refining"],
  refining: ["dispatching"],
  dispatching: [], // auto-advance only (Task completion)
  reviewing: ["dispatching", "reporting"], // dispatching = iterate
  reporting: ["complete"],
  complete: [], // auto-reset only (new chat.message)
}

/** Human-readable target names the model uses → actual phase */
const TARGET_ALIASES: Record<string, Phase> = {
  refine: "refining",
  dispatch: "dispatching",
  iterate: "dispatching", // reviewing → dispatching is "iterate"
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): PipelineState {
  return {
    phase: "brainstorming",
    iterations: 0,
    gitDiffCalled: false,
    startTime: Date.now(),
    dispatches: 0,
  }
}

function formatStatus(state: PipelineState): string {
  const valid = TRANSITIONS[state.phase]
    .map((p) => {
      // Reverse-lookup the alias name the model should use
      for (const [alias, target] of Object.entries(TARGET_ALIASES)) {
        if (target === p) {
          // For reviewing → dispatching, the alias is "iterate"
          if (state.phase === "reviewing" && p === "dispatching") return "iterate"
          return alias
        }
      }
      return p
    })

  const parts = [
    `Phase: ${state.phase}`,
    `Iteration: ${state.iterations}/${MAX_ITERATIONS}`,
    `git diff called: ${state.gitDiffCalled}`,
    `Dispatches: ${state.dispatches}`,
    `Valid transitions: ${valid.length > 0 ? valid.join(", ") : "(none — automatic)"}`,
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

  return `[Pipeline: ${state.phase} | iter ${state.iterations}/${MAX_ITERATIONS} | git diff: ${state.gitDiffCalled ? "done" : "needed"} | next: ${valid.join(", ") || "auto"}]`
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PipelineEnforcer: Plugin = async ({ client }) => {
  /** Per-session pipeline state. Only populated for orchestrator sessions. */
  const sessions = new Map<string, PipelineState>()

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
        return `ERROR: Cannot transition from '${state.phase}' to '${args.target}'. Valid transitions from '${state.phase}': ${aliasNames.length > 0 ? aliasNames.join(", ") : "(none — transitions are automatic)"}`
      }

      // --- Prerequisite checks ---

      // iterate: must be under max iterations
      if (args.target === "iterate") {
        if (state.iterations >= MAX_ITERATIONS) {
          return `ERROR: Maximum iterations (${MAX_ITERATIONS}) reached. You must proceed to 'report' instead. Note any remaining issues as caveats.`
        }
        // Reset gitDiffCalled for next review cycle
        state.gitDiffCalled = false
        state.iterations++
        state.dispatches++
        state.phase = "dispatching"

        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: `Phase: reviewing → dispatching (iterate #${state.iterations})`,
            extra: { sessionID: ctx.sessionID, iteration: state.iterations },
          },
        })

        return `Advanced to DISPATCHING (iteration ${state.iterations}/${MAX_ITERATIONS}). ${PHASE_GUIDANCE.dispatching}`
      }

      // report: must have called git diff
      if (args.target === "report") {
        if (!state.gitDiffCalled) {
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
          message: `Phase: ${previousPhase} → ${targetPhase}`,
          extra: { sessionID: ctx.sessionID, iteration: state.iterations },
        },
      })

      // Pipeline completion toast
      if (targetPhase === "complete") {
        const elapsed = Math.round((Date.now() - state.startTime) / 1000)
        await client.tui.showToast({
          body: {
            message: `Pipeline complete: ${state.dispatches} dispatch(es), ${state.iterations} review cycle(s), ${elapsed}s`,
            variant: "success",
          },
        })
      }

      return `Advanced to ${targetPhase.toUpperCase()}. ${PHASE_GUIDANCE[targetPhase]}`
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

      return `${formatStatus(state)}\n\nCurrent phase guidance: ${PHASE_GUIDANCE[state.phase]}`
    },
  })

  // -------------------------------------------------------------------------
  // Hook implementations
  // -------------------------------------------------------------------------

  return {
    tool: {
      pipeline_advance: pipelineAdvance,
      pipeline_status: pipelineStatus,
    },

    // -- Initialize pipeline state for orchestrator sessions ----------------
    "chat.message": async (input) => {
      if (input.agent !== ORCHESTRATOR_AGENT) return

      const existing = sessions.get(input.sessionID)
      if (!existing) {
        // First message in this session — initialize
        sessions.set(input.sessionID, freshState())
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: "Pipeline initialized: brainstorming",
            extra: { sessionID: input.sessionID },
          },
        })
        return
      }

      // Session already has state. If complete, reset for new request.
      if (existing.phase === "complete") {
        sessions.set(input.sessionID, freshState())
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: "Pipeline reset: complete → brainstorming (new user message)",
            extra: { sessionID: input.sessionID },
          },
        })
      }
    },

    // -- Guard tools based on phase ----------------------------------------
    "tool.execute.before": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (!state) return // Not an orchestrator session

      const toolName = input.tool

      // Block Task tool unless in dispatching phase
      if (toolName === "task" || toolName === "Task") {
        if (state.phase !== "dispatching") {
          throw new Error(
            `BLOCKED: The Task tool can only be used during the 'dispatching' phase. ` +
            `Current phase: '${state.phase}'. ` +
            `Call pipeline_advance() to reach the dispatching phase first.`
          )
        }
      }

      // Defense-in-depth: block write/edit for orchestrator
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

      // Track git diff calls during reviewing phase
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

      // Auto-advance dispatching → reviewing when Task completes
      if (
        (toolName === "task" || toolName === "Task") &&
        state.phase === "dispatching"
      ) {
        // Check for Task failure by inspecting the output.
        // Be conservative — only match unambiguous failure signals.
        // The implementer output may legitimately contain words like "Error"
        // when describing what it fixed.
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
          // Stay in dispatching — let the model decide what to do
          await client.app.log({
            body: {
              service: "pipeline-enforcer",
              level: "warn",
              message:
                "Task tool returned possible failure — staying in dispatching phase",
              extra: {
                sessionID: input.sessionID,
                outputPreview: taskOutput.slice(0, 200),
              },
            },
          })
          return
        }

        // Success — auto-advance to reviewing
        state.phase = "reviewing"
        await client.app.log({
          body: {
            service: "pipeline-enforcer",
            level: "info",
            message: "Phase: dispatching → reviewing (auto-advance on Task completion)",
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

      output.system.push(
        `\n${statusBanner(state)}\n` +
        `You MUST call pipeline_advance() to transition between phases. ` +
        `You MUST call pipeline_status() if you are unsure where you are. ` +
        `The Task tool is ONLY available during the dispatching phase.`
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
        `- Total dispatches: ${state.dispatches}\n` +
        `- Elapsed: ${Math.round((Date.now() - state.startTime) / 1000)}s\n` +
        `- Current guidance: ${PHASE_GUIDANCE[state.phase]}`
      )
    },

    // -- Observability (absorbed from workflow-logger) ---------------------
    event: async ({ event }) => {
      const props = event.properties ?? {}

      // Log errors
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
