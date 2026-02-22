import type { Plugin } from "@opencode-ai/plugin"

export const WorkflowLogger: Plugin = async ({ client }) => {
  const pipelineState: Record<
    string,
    { dispatches: number; startTime: number }
  > = {}

  return {
    event: async ({ event }) => {
      const props = event.properties ?? {}

      // Track when child sessions are created (implementation dispatches)
      if (event.type === "session.created" && props.parentID) {
        const parentID = String(props.parentID)
        if (!pipelineState[parentID]) {
          pipelineState[parentID] = { dispatches: 0, startTime: Date.now() }
        }
        pipelineState[parentID].dispatches++

        const count = pipelineState[parentID].dispatches
        const label =
          count === 1
            ? "Implementation dispatched"
            : `Review cycle #${count - 1} - re-dispatching`

        await client.app.log({
          body: {
            service: "meta-orchestrator",
            level: "info",
            message: label,
            extra: {
              parentSession: parentID,
              dispatchCount: count,
            },
          },
        })
      }

      // Notify when orchestrator goes idle (pipeline likely complete)
      if (event.type === "session.idle") {
        const sessionID = String(props.id ?? props.sessionID ?? "")
        if (!sessionID) return

        if (pipelineState[sessionID]) {
          const state = pipelineState[sessionID]
          const elapsed = Math.round((Date.now() - state.startTime) / 1000)
          const reviewCycles = Math.max(0, state.dispatches - 1)

          await client.tui.showToast({
            body: {
              message: `Pipeline complete: ${state.dispatches} dispatch(es), ${reviewCycles} review cycle(s), ${elapsed}s elapsed`,
              variant: "success",
            },
          })

          await client.app.log({
            body: {
              service: "meta-orchestrator",
              level: "info",
              message: `Pipeline complete`,
              extra: {
                sessionID,
                dispatches: state.dispatches,
                reviewCycles,
                elapsedSeconds: elapsed,
              },
            },
          })

          delete pipelineState[sessionID]
        }
      }

      // Log errors
      if (event.type === "session.error") {
        const sessionID = String(props.id ?? props.sessionID ?? "unknown")
        await client.app.log({
          body: {
            service: "meta-orchestrator",
            level: "error",
            message: `Session error in pipeline`,
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
