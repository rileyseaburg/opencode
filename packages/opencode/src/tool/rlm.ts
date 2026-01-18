import { Tool } from "./tool"
import { RlmRepl } from "./rlm-repl"
import { Provider } from "../provider/provider"
import { MessageV2 } from "../session/message-v2"
import { Log } from "../util/log"
import { generateText } from "ai"
import fs from "fs/promises"
import z from "zod"
import DESCRIPTION from "./rlm.txt"
import { Instance } from "../project/instance"

const log = Log.create({ service: "rlm-tool" })

// Configurable limits (env vars or defaults)
const MAX_SUBCALLS_PER_ITERATION = Number(process.env.A2A_RLM_MAX_SUBCALLS_PER_ITERATION) || 5
const MAX_TOTAL_SUBCALLS = Number(process.env.A2A_RLM_MAX_TOTAL_SUBCALLS) || 100
const MAX_SUBCALL_TOKENS = Number(process.env.A2A_RLM_MAX_SUBCALL_TOKENS) || 8000
const MAX_ITERATIONS = Number(process.env.A2A_RLM_MAX_ITERATIONS) || 20

// Parse normalized ref (split on first colon)
function parseNormalizedRef(ref: string): { provider: string; model: string } {
  const idx = ref.indexOf(":")
  if (idx === -1) throw new Error(`Invalid model ref: ${ref} (expected provider:model)`)
  return {
    provider: ref.slice(0, idx),
    model: ref.slice(idx + 1),
  }
}

// Extract FINAL(...) or FINAL_VAR(...) from output
function extractFinal(stdout: string): { type: "direct" | "var"; value: string } | null {
  // Check for FINAL_VAR first (more specific)
  const varMatch = stdout.match(/FINAL_VAR\s*\(\s*["']?(\w+)["']?\s*\)/i)
  if (varMatch && varMatch[1]) {
    return { type: "var", value: varMatch[1] }
  }

  // Check for FINAL(...)
  const directMatch = stdout.match(/FINAL\s*\(\s*["'](.+?)["']\s*\)/is)
  if (directMatch && directMatch[1]) {
    return { type: "direct", value: directMatch[1] }
  }

  // Check for FINAL(...) with variable
  const directVarMatch = stdout.match(/FINAL\s*\(\s*(\w+)\s*\)/i)
  if (directVarMatch && directVarMatch[1] && directVarMatch[1] !== "FINAL_VAR") {
    return { type: "var", value: directVarMatch[1] }
  }

  return null
}

// Load context from file paths
async function loadContextFromPaths(paths: string[]): Promise<string[]> {
  const contents: string[] = []
  for (const p of paths) {
    const content = await fs.readFile(p, "utf-8").catch(() => `[Error reading ${p}]`)
    contents.push(`--- FILE: ${p} ---\n${content}`)
  }
  return contents
}

// Load context from glob pattern
async function loadContextFromGlob(pattern: string, cwd: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern)
  const contents: string[] = []

  for await (const file of glob.scan({ cwd, absolute: true, onlyFiles: true })) {
    const content = await fs.readFile(file, "utf-8").catch(() => `[Error reading ${file}]`)
    contents.push(`--- FILE: ${file} ---\n${content}`)
  }

  return contents
}

interface Task {
  resolved_subcall_model_ref?: string
  resolved_subcall_source?: string
  resolved_subcall_warning?: string
}

export const RlmTool = Tool.define("rlm", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      query: z.string().describe("The task to accomplish using RLM"),
      context: z.string().optional().describe("Direct context string to analyze"),
      context_paths: z.array(z.string()).optional().describe("File paths to load as context"),
      context_glob: z.string().optional().describe("Glob pattern to load files as context"),
      max_iterations: z.number().optional().describe(`Max iterations (default ${MAX_ITERATIONS})`),
    }),

    async execute(params, ctx) {
      // Get resolved subcall model from task context (A2A is source of truth)
      const task = ctx.extra?.task as Task | undefined
      const subcallModelRef = task?.resolved_subcall_model_ref
      const subcallWarning = task?.resolved_subcall_warning
      const subcallSource = task?.resolved_subcall_source

      if (subcallWarning) {
        log.warn("RLM subcall warning from A2A", { warning: subcallWarning })
      }

      // Resolve subcall model
      let subcallModel: Awaited<ReturnType<typeof Provider.getLanguage>> | null = null

      if (subcallModelRef) {
        try {
          const { provider, model } = parseNormalizedRef(subcallModelRef)
          const fullModel = await Provider.getModel(provider, model)
          subcallModel = await Provider.getLanguage(fullModel)
          log.info("Using resolved subcall model", { ref: subcallModelRef, source: subcallSource })
        } catch (e) {
          log.warn("Failed to load resolved subcall model, falling back", { ref: subcallModelRef, error: e })
        }
      }

      // Fallback: use session's current model
      if (!subcallModel) {
        const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        // For assistant messages, use msg.info.providerID/modelID
        // For user messages, use msg.info.model.providerID/modelID
        const providerID = msg.info.role === "assistant" ? msg.info.providerID : msg.info.model.providerID
        const modelID = msg.info.role === "assistant" ? msg.info.modelID : msg.info.model.modelID
        const fallbackRef = `${providerID}:${modelID}`
        log.warn("Using controller model for RLM subcalls", { ref: fallbackRef })

        const fullModel = await Provider.getModel(providerID, modelID)
        subcallModel = await Provider.getLanguage(fullModel)
      }

      // Load context
      let context: string | string[]

      if (params.context) {
        context = params.context
      } else if (params.context_paths && params.context_paths.length > 0) {
        context = await loadContextFromPaths(params.context_paths)
      } else if (params.context_glob) {
        context = await loadContextFromGlob(params.context_glob, Instance.directory)
      } else {
        throw new Error("One of context, context_paths, or context_glob is required")
      }

      // Create REPL
      const repl = await RlmRepl.create(context, {
        disableNetwork: true,
      })

      // Usage accounting
      const usage = {
        iterations: 0,
        totalSubcalls: 0,
        totalSubcallTokens: 0,
      }

      const maxIterations = params.max_iterations ?? MAX_ITERATIONS

      try {
        let finalAnswer: string | null = null

        for (let i = 0; i < maxIterations && !finalAnswer; i++) {
          usage.iterations = i + 1
          let iterationSubcalls = 0

          // Get agent's code for this iteration
          // In a full implementation, this would query the controller LLM
          // For now, we'll execute a simple exploration if no code is provided
          const agentCode =
            i === 0
              ? `
print("Query:", ${JSON.stringify(params.query)})
print("Context type:", type(context))
if isinstance(context, list):
    print(f"Context chunks: {len(context)}")
    print(f"Total chars: {sum(len(c) for c in context)}")
else:
    print(f"Context length: {len(context)} chars")
    print(f"Context lines: {context.count(chr(10)) + 1}")
print("\\nFirst 500 chars of context:")
print((context_joined if isinstance(context, list) else context)[:500])
`
              : `print("Iteration ${i + 1} - waiting for agent code")`

          // Execute with llm_query interception
          const result = await RlmRepl.execute(repl, agentCode, async (prompt) => {
            // Enforce per-iteration limit
            if (iterationSubcalls >= MAX_SUBCALLS_PER_ITERATION) {
              return `[ERROR: Max subcalls per iteration (${MAX_SUBCALLS_PER_ITERATION}) exceeded. Use code-based filtering or batch remaining work.]`
            }
            // Enforce total limit
            if (usage.totalSubcalls >= MAX_TOTAL_SUBCALLS) {
              return `[ERROR: Max total subcalls (${MAX_TOTAL_SUBCALLS}) exceeded. You must provide a FINAL answer now.]`
            }

            iterationSubcalls++
            usage.totalSubcalls++

            try {
              const response = await generateText({
                model: subcallModel!,
                messages: [{ role: "user", content: prompt }],
                maxOutputTokens: MAX_SUBCALL_TOKENS,
              })

              usage.totalSubcallTokens += response.usage?.totalTokens ?? 0
              return response.text
            } catch (e) {
              log.error("Subcall failed", { error: e })
              return `[ERROR: Subcall failed - ${e}]`
            }
          })

          // Check for FINAL markers
          const finalResult = extractFinal(result.stdout)
          if (finalResult) {
            if (finalResult.type === "var") {
              // Get variable value from REPL
              const varValue = await RlmRepl.getVariable(repl, finalResult.value)
              finalAnswer = varValue
            } else {
              finalAnswer = finalResult.value
            }
          }

          // Update metadata for UI feedback
          ctx.metadata({
            metadata: {
              iteration: i + 1,
              maxIterations,
              stdout: result.stdout.slice(0, 10000),
              stderr: result.stderr.slice(0, 2000),
              subcallsThisIteration: iterationSubcalls,
              totalSubcalls: usage.totalSubcalls,
              totalTokens: usage.totalSubcallTokens,
            },
          })

          // If first iteration, break to let the calling agent continue
          // In a full implementation, this would loop with agent code
          if (i === 0 && !finalAnswer) {
            finalAnswer = result.stdout
          }
        }

        return {
          title: "RLM Analysis",
          output: finalAnswer ?? `Max iterations (${maxIterations}) reached without FINAL answer`,
          metadata: {
            iterations: usage.iterations,
            totalSubcalls: usage.totalSubcalls,
            totalSubcallTokens: usage.totalSubcallTokens,
            subcallModelRef: subcallModelRef ?? "controller",
            subcallSource: subcallSource ?? "fallback",
            warning: subcallWarning,
          },
        }
      } finally {
        await RlmRepl.destroy(repl)
      }
    },
  }
})
