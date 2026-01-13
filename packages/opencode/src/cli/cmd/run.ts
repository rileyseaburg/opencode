import type { Argv } from "yargs"
import path from "path"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { bootstrap } from "../bootstrap"
import { Command } from "../../command"
import { EOL } from "os"
import { select } from "@clack/prompts"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider/provider"
import { Agent } from "../../agent/agent"
import { Config } from "../../config/config"
import { Auth } from "../../auth"
import { Env } from "../../env"
import { spawn } from "bun"

const TOOL: Record<string, [string, string]> = {
  todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  todoread: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  bash: ["Bash", UI.Style.TEXT_DANGER_BOLD],
  edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
  glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
  grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
  list: ["List", UI.Style.TEXT_INFO_BOLD],
  read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
  write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
  websearch: ["Search", UI.Style.TEXT_DIM_BOLD],
}

namespace VoiceMode {
  export function status(text: string) {
    process.stderr.write(`\r${UI.Style.TEXT_INFO_BOLD}[Voice]${UI.Style.TEXT_NORMAL} ${text}`)
  }

  export function clearStatus() {
    process.stderr.write("\r\x1b[K")
  }

  export async function recordAudio(durationMs = 10000): Promise<Buffer> {
    status("Recording... (press Enter to stop)")

    const chunks: Buffer[] = []
    const proc = spawn({
      cmd: ["sox", "-d", "-t", "wav", "-r", "16000", "-c", "1", "-b", "16", "-"],
      stdout: "pipe",
      stderr: "ignore",
    })

    const reader = proc.stdout.getReader()
    const readLoop = (async () => {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        chunks.push(Buffer.from(result.value))
      }
    })()

    const stopPromise = new Promise<void>((resolve) => {
      const handler = (data: Buffer) => {
        if (data.toString().includes("\n") || data.toString().includes("\r")) {
          process.stdin.removeListener("data", handler)
          process.stdin.setRawMode?.(false)
          resolve()
        }
      }
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.on("data", handler)
    })

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, durationMs))
    await Promise.race([stopPromise, timeout])

    proc.kill("SIGTERM")
    await readLoop.catch(() => {})

    clearStatus()
    UI.println(UI.Style.TEXT_DIM + `Recorded ${chunks.length > 0 ? "audio" : "no audio"}`)

    return Buffer.concat(chunks)
  }

  async function getGoogleKey(): Promise<string> {
    const envKey = Env.get("GOOGLE_API_KEY") || Env.get("GEMINI_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("google")
    if (auth?.type === "api") return auth.key

    throw new Error("Google API key not found. Set GOOGLE_API_KEY or run: opencode auth google")
  }

  export async function transcribe(audio: Buffer, config: Config.Info): Promise<string> {
    status("Transcribing...")

    const apiKey = await getGoogleKey()
    const base64Audio = audio.toString("base64")

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: "audio/wav",
                    data: base64Audio,
                  },
                },
                {
                  text: "Transcribe this audio exactly. Return only the transcription, no other text.",
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
          },
        }),
      },
    )

    if (!response.ok) {
      clearStatus()
      const text = await response.text()
      throw new Error(`Transcription failed: ${response.status} ${text}`)
    }

    const result = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string
          }>
        }
      }>
    }

    clearStatus()
    return result.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  }

  export async function speak(text: string, config: Config.Info): Promise<void> {
    const voiceConfig = config.voice
    if (!voiceConfig?.autoSpeak) return

    status("Speaking...")

    const apiKey = await getGoogleKey().catch(() => null)
    if (!apiKey) {
      clearStatus()
      UI.println(UI.Style.TEXT_WARNING + "Skipping TTS: Google API key not configured")
      return
    }

    const voice = voiceConfig.ttsVoice || "Zephyr"
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Read aloud: ${text}`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 1,
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
          },
        }),
      },
    )

    if (!response.ok) {
      clearStatus()
      UI.println(UI.Style.TEXT_WARNING + `TTS failed: ${response.status}`)
      return
    }

    const result = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: {
              mimeType?: string
              data?: string
            }
          }>
        }
      }>
    }

    const inlineData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData
    if (!inlineData?.data) {
      clearStatus()
      UI.println(UI.Style.TEXT_WARNING + "TTS: No audio data received")
      return
    }

    const rawBuffer = Buffer.from(inlineData.data, "base64")
    const wavBuffer = convertToWav(rawBuffer, inlineData.mimeType ?? "audio/L16;rate=24000")

    const proc = spawn({
      cmd: ["aplay", "-q", "-"],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })

    proc.stdin.write(wavBuffer)
    proc.stdin.end()
    await proc.exited

    clearStatus()
  }

  function convertToWav(rawData: Buffer, mimeType: string): Buffer {
    const options = parseMimeType(mimeType)
    const wavHeader = createWavHeader(rawData.length, options)
    return Buffer.concat([wavHeader, rawData])
  }

  function parseMimeType(mimeType: string): { numChannels: number; sampleRate: number; bitsPerSample: number } {
    const [fileType, ...params] = mimeType.split(";").map((s) => s.trim())
    const [, format] = fileType.split("/")

    const options = {
      numChannels: 1,
      sampleRate: 24000,
      bitsPerSample: 16,
    }

    if (format && format.startsWith("L")) {
      const bits = parseInt(format.slice(1), 10)
      if (!isNaN(bits)) {
        options.bitsPerSample = bits
      }
    }

    for (const param of params) {
      const [k, value] = param.split("=").map((s) => s.trim())
      if (k === "rate") {
        options.sampleRate = parseInt(value, 10)
      }
    }

    return options
  }

  function createWavHeader(
    dataLength: number,
    options: { numChannels: number; sampleRate: number; bitsPerSample: number },
  ): Buffer {
    const { numChannels, sampleRate, bitsPerSample } = options
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
    const blockAlign = (numChannels * bitsPerSample) / 8
    const buffer = Buffer.alloc(44)

    buffer.write("RIFF", 0)
    buffer.writeUInt32LE(36 + dataLength, 4)
    buffer.write("WAVE", 8)
    buffer.write("fmt ", 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)
    buffer.write("data", 36)
    buffer.writeUInt32LE(dataLength, 40)

    return buffer
  }
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("headless", {
        type: "boolean",
        describe: "run in headless mode (no TTY, auto-approve permissions)",
        default: false,
      })
      .option("auto-approve", {
        type: "string",
        choices: ["all", "safe", "none"],
        default: "safe",
        describe:
          "auto-approve policy for headless mode: all (approve everything), safe (approve read-only), none (reject all)",
      })
      .option("voice", {
        type: "boolean",
        describe: "enable voice mode: record audio, transcribe, send to LLM, optionally speak response",
        default: false,
      })
  },
  handler: async (args) => {
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const fileParts: any[] = []
    if (args.file) {
      const files = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of files) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        const file = Bun.file(resolvedPath)
        const stats = await file.stat().catch(() => {})
        if (!stats) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }
        if (!(await file.exists())) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const stat = await file.stat()
        const mime = stat.isDirectory() ? "application/x-directory" : "text/plain"

        fileParts.push({
          type: "file",
          url: `file://${resolvedPath}`,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    if (!process.stdin.isTTY && !args.voice) message += "\n" + (await Bun.stdin.text())

    if (message.trim().length === 0 && !args.command && !args.voice) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    const execute = async (sdk: OpencodeClient, sessionID: string): Promise<string | undefined> => {
      const printEvent = (color: string, type: string, title: string) => {
        UI.println(
          color + `|`,
          UI.Style.TEXT_NORMAL + UI.Style.TEXT_DIM + ` ${type.padEnd(7, " ")}`,
          "",
          UI.Style.TEXT_NORMAL + title,
        )
      }

      const outputJsonEvent = (type: string, data: any) => {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      const events = await sdk.event.subscribe()
      let errorMsg: string | undefined
      let responseText: string | undefined

      const eventProcessor = (async () => {
        for await (const event of events.stream) {
          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            if (part.type === "tool" && part.state.status === "completed") {
              if (outputJsonEvent("tool_use", { part })) continue
              const [tool, color] = TOOL[part.tool] ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
              const title =
                part.state.title ||
                (Object.keys(part.state.input).length > 0 ? JSON.stringify(part.state.input) : "Unknown")
              printEvent(color, tool, title)
              if (part.tool === "bash" && part.state.output?.trim()) {
                UI.println()
                UI.println(part.state.output)
              }
            }

            if (part.type === "step-start") {
              if (outputJsonEvent("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (outputJsonEvent("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              if (outputJsonEvent("text", { part })) continue
              const isPiped = !process.stdout.isTTY
              if (!isPiped) UI.println()
              process.stdout.write((isPiped ? part.text : UI.markdown(part.text)) + EOL)
              if (!isPiped) UI.println()
              responseText = part.text
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            let err = String(props.error.name)
            if ("data" in props.error && props.error.data && "message" in props.error.data) {
              err = String(props.error.data.message)
            }
            errorMsg = errorMsg ? errorMsg + EOL + err : err
            if (outputJsonEvent("error", { error: props.error })) continue
            UI.error(err)
          }

          if (event.type === "session.idle" && event.properties.sessionID === sessionID) {
            break
          }

          if (event.type === "permission.updated") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue

            let response: "once" | "always" | "reject"

            // In headless/voice mode, auto-respond based on policy
            if (args.headless || args.voice || !process.stdin.isTTY) {
              const policy = args["auto-approve"] || "safe"
              const toolName = permission.type || ""
              const isReadOnly = ["read", "glob", "grep", "list", "websearch"].includes(toolName)

              if (policy === "all") {
                response = "once"
                if (args.format !== "json") {
                  UI.println(UI.Style.TEXT_INFO_BOLD + "~", UI.Style.TEXT_NORMAL, `Auto-approved: ${permission.title}`)
                }
              } else if (policy === "safe" && isReadOnly) {
                response = "once"
                if (args.format !== "json") {
                  UI.println(
                    UI.Style.TEXT_INFO_BOLD + "~",
                    UI.Style.TEXT_NORMAL,
                    `Auto-approved (safe): ${permission.title}`,
                  )
                }
              } else {
                response = "reject"
                if (args.format !== "json") {
                  UI.println(
                    UI.Style.TEXT_WARNING_BOLD + "!",
                    UI.Style.TEXT_NORMAL,
                    `Auto-rejected: ${permission.title}`,
                  )
                }
              }
              outputJsonEvent("permission", { permission, response, auto: true })
            } else {
              // Interactive mode - prompt user
              const result = await select({
                message: `Permission required to run: ${permission.title}`,
                options: [
                  { value: "once", label: "Allow once" },
                  { value: "always", label: "Always allow" },
                  { value: "reject", label: "Reject" },
                ],
                initialValue: "once",
              }).catch(() => "reject")
              response = (result.toString().includes("cancel") ? "reject" : result) as "once" | "always" | "reject"
            }

            await sdk.permission.respond({
              sessionID,
              permissionID: permission.id,
              response,
            })
          }
        }
      })()

      // Validate agent if specified
      const resolvedAgent = await (async () => {
        if (!args.agent) return undefined
        const agent = await Agent.get(args.agent)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return args.agent
      })()

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent: resolvedAgent,
          model: args.model,
          command: args.command,
          arguments: message,
        })
      } else {
        const modelParam = args.model ? Provider.parseModel(args.model) : undefined
        await sdk.session.prompt({
          sessionID,
          agent: resolvedAgent,
          model: modelParam,
          parts: [...fileParts, { type: "text", text: message }],
        })
      }

      await eventProcessor
      if (errorMsg && !args.voice) process.exit(1)

      return responseText
    }

    const executeVoiceLoop = async (sdk: OpencodeClient, sessionID: string) => {
      const config = await Config.get()
      let running = true

      process.on("SIGINT", () => {
        running = false
        VoiceMode.clearStatus()
        UI.println(EOL + UI.Style.TEXT_DIM + "Voice mode exited")
        process.exit(0)
      })

      UI.println(
        UI.Style.TEXT_INFO_BOLD +
          "[Voice Mode]" +
          UI.Style.TEXT_NORMAL +
          " Press Enter to stop recording, Ctrl+C to exit",
      )
      UI.println()

      while (running) {
        const audio = await VoiceMode.recordAudio()
        if (audio.length === 0) {
          UI.println(UI.Style.TEXT_WARNING + "No audio recorded, try again")
          continue
        }

        const transcript = await VoiceMode.transcribe(audio, config).catch((err: Error) => {
          UI.error(err.message)
          return ""
        })
        if (!transcript) continue

        UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "You: " + UI.Style.TEXT_NORMAL + transcript)
        UI.println()

        message = transcript
        const response = await execute(sdk, sessionID)

        if (response && config.voice?.autoSpeak) {
          await VoiceMode.speak(response, config)
        }

        UI.println()
      }
    }

    if (args.attach) {
      const sdk = createOpencodeClient({ baseUrl: args.attach })

      const sessionID = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list()
          return result.data?.find((s) => !s.parentID)?.id
        }
        if (args.session) return args.session

        const title =
          args.title !== undefined
            ? args.title === ""
              ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
              : args.title
            : undefined

        const result = await sdk.session.create(title ? { title } : {})
        return result.data?.id
      })()

      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }

      const cfgResult = await sdk.config.get()
      const config = cfgResult.data
      if (config && (config.share === "auto" || Flag.OPENCODE_AUTO_SHARE || args.share)) {
        const shareResult = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!shareResult.error && "data" in shareResult && shareResult.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + shareResult.data.share.url)
        }
      }

      if (args.voice) {
        await executeVoiceLoop(sdk, sessionID)
        return
      }
      await execute(sdk, sessionID)
    }

    await bootstrap(process.cwd(), async () => {
      const server = Server.listen({ port: args.port ?? 0, hostname: "127.0.0.1" })
      const sdk = createOpencodeClient({ baseUrl: `http://${server.hostname}:${server.port}` })

      if (args.command) {
        const exists = await Command.get(args.command)
        if (!exists) {
          server.stop()
          UI.error(`Command "${args.command}" not found`)
          process.exit(1)
        }
      }

      const sessionID = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list()
          return result.data?.find((s) => !s.parentID)?.id
        }
        if (args.session) return args.session

        const title =
          args.title !== undefined
            ? args.title === ""
              ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
              : args.title
            : undefined

        const result = await sdk.session.create(title ? { title } : {})
        return result.data?.id
      })()

      if (!sessionID) {
        server.stop()
        UI.error("Session not found")
        process.exit(1)
      }

      const cfgResult = await sdk.config.get()
      if (cfgResult.data && (cfgResult.data.share === "auto" || Flag.OPENCODE_AUTO_SHARE || args.share)) {
        const shareResult = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!shareResult.error && "data" in shareResult && shareResult.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + shareResult.data.share.url)
        }
      }

      if (args.voice) {
        await executeVoiceLoop(sdk, sessionID)
        server.stop()
        return
      }

      await execute(sdk, sessionID)
      server.stop()
    })
  },
})
