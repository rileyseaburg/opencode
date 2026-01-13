import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"

// Model selector: maps user-friendly names to full provider/model-id
const MODEL_SELECTOR: Record<string, string> = {
  // Anthropic
  "claude-sonnet": "anthropic/claude-sonnet-4-20250514",
  "claude-sonnet-4": "anthropic/claude-sonnet-4-20250514",
  sonnet: "anthropic/claude-sonnet-4-20250514",
  "claude-opus": "anthropic/claude-opus-4-20250514",
  opus: "anthropic/claude-opus-4-20250514",
  "claude-haiku": "anthropic/claude-haiku",
  haiku: "anthropic/claude-haiku",
  // Azure Anthropic
  "azure-opus": "azure-anthropic/claude-opus-4-5",
  "azure-anthropic": "azure-anthropic/claude-opus-4-5",
  // Minimax (custom provider via Anthropic SDK)
  minimax: "minimax-m2/MiniMax-M2.1",
  "minimax-m2": "minimax-m2/MiniMax-M2.1",
  "minimax-m2.1": "minimax-m2/MiniMax-M2.1",
  "m2.1": "minimax-m2/MiniMax-M2.1",
  "m2": "minimax-m2/MiniMax-M2",
  // OpenAI
  "gpt-4": "openai/gpt-4",
  "gpt-4o": "openai/gpt-4o",
  "gpt-4-turbo": "openai/gpt-4-turbo",
  "gpt-4.1": "openai/gpt-4.1",
  o1: "openai/o1",
  "o1-mini": "openai/o1-mini",
  o3: "openai/o3",
  "o3-mini": "openai/o3-mini",
  // Google
  gemini: "google/gemini-2.5-pro",
  "gemini-pro": "google/gemini-2.5-pro",
  "gemini-2.5-pro": "google/gemini-2.5-pro",
  "gemini-flash": "google/gemini-2.5-flash",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  // xAI
  grok: "xai/grok-3",
  "grok-3": "xai/grok-3",
}

function resolveModel(input: string): string {
  const key = input.toLowerCase().trim()
  // If already in provider/model format, return as-is
  if (input.includes("/")) return input
  // Look up in selector
  return MODEL_SELECTOR[key] ?? input
}

export const TaskTool = Tool.define("task", async () => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
  const description = DESCRIPTION.replace(
    "{agents}",
    agents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters: z.object({
      description: z.string().describe("A short (3-5 words) description of the task"),
      prompt: z.string().describe("The task for the agent to perform"),
      subagent_type: z.string().describe("The type of specialized agent to use for this task"),
      session_id: z.string().describe("Existing Task session to continue").optional(),
      command: z.string().describe("The command that triggered this task").optional(),
      model: z
        .string()
        .describe(
          "Optional model to use. Use friendly names like 'minimax', 'claude-sonnet', 'gemini', 'gpt-4o', 'grok' - or full format like 'anthropic/claude-sonnet-4-20250514'",
        )
        .optional(),
    }),
    async execute(params, ctx) {
      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
        },
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: session.id,
          },
        })
      })

      const model = params.model
        ? Provider.parseModel(resolveModel(params.model))
        : (agent.model ?? {
            modelID: msg.info.modelID,
            providerID: msg.info.providerID,
          })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const config = await Config.get()
      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          task: false,
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
          ...agent.tools,
        },
        parts: promptParts,
      })
      unsub()
      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = text + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
        },
        output,
      }
    },
  }
})
