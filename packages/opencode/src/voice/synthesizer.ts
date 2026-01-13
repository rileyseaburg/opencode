import { Log } from "../util/log"
import { Auth } from "../auth"
import { Env } from "../env"
import { spawn } from "bun"

export namespace Synthesizer {
  const log = Log.create({ service: "voice.synthesizer" })

  export type Provider = "google" | "openai" | "elevenlabs" | "system"
  export type OpenAIVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
  export type GoogleVoice = "Zephyr" | "Puck" | "Charon" | "Kore" | "Fenrir" | "Aoede" | "Leda" | "Orus" | "Proteus"

  export interface Options {
    provider?: Provider
    voice?: string
    model?: string
    speed?: number
  }

  const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
  const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech"
  const GOOGLE_GENAI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

  async function getGoogleKey(): Promise<string> {
    const envKey = Env.get("GOOGLE_API_KEY") || Env.get("GEMINI_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("google")
    if (auth?.type === "api") return auth.key

    throw new Error("Google API key not found. Set GOOGLE_API_KEY or authenticate with google provider.")
  }

  async function getOpenAIKey(): Promise<string> {
    const envKey = Env.get("OPENAI_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("openai")
    if (auth?.type === "api") return auth.key

    throw new Error("OpenAI API key not found. Set OPENAI_API_KEY or authenticate with openai provider.")
  }

  async function getElevenLabsKey(): Promise<string> {
    const envKey = Env.get("ELEVENLABS_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("elevenlabs")
    if (auth?.type === "api") return auth.key

    throw new Error("ElevenLabs API key not found. Set ELEVENLABS_API_KEY or authenticate with elevenlabs provider.")
  }

  export async function speak(text: string, options: Options = {}): Promise<void> {
    const audio = await synthesize(text, options)
    await playAudio(audio)
  }

  export async function synthesize(text: string, options: Options = {}): Promise<Buffer> {
    const provider = options.provider ?? "google"

    log.info("synthesizing", { provider, length: text.length })

    if (provider === "google") {
      return synthesizeWithGoogle(text, options)
    }

    if (provider === "openai") {
      return synthesizeWithOpenAI(text, options)
    }

    if (provider === "elevenlabs") {
      return synthesizeWithElevenLabs(text, options)
    }

    if (provider === "system") {
      return synthesizeWithSystem(text, options)
    }

    throw new Error(`unsupported synthesis provider: ${provider}`)
  }

  async function synthesizeWithGoogle(text: string, options: Options): Promise<Buffer> {
    const key = await getGoogleKey()
    const voice = (options.voice ?? "Zephyr") as GoogleVoice
    const model = options.model ?? "gemini-2.5-flash-preview-tts"

    const response = await fetch(`${GOOGLE_GENAI_URL}/${model}:generateContent?key=${key}`, {
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
                text: `Read aloud in a warm and friendly tone: ${text}`,
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
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("google synthesis failed", { status: response.status, error })
      throw new Error(`Google synthesis failed: ${response.status} ${error}`)
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
      throw new Error("No audio data in Google response")
    }

    const rawBuffer = Buffer.from(inlineData.data, "base64")
    return convertToWav(rawBuffer, inlineData.mimeType ?? "audio/L16;rate=24000")
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

  async function synthesizeWithOpenAI(text: string, options: Options): Promise<Buffer> {
    const key = await getOpenAIKey()
    const voice = (options.voice ?? "alloy") as OpenAIVoice
    const model = options.model ?? "tts-1"
    const speed = options.speed ?? 1.0

    const response = await fetch(OPENAI_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        speed,
        response_format: "mp3",
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("openai synthesis failed", { status: response.status, error })
      throw new Error(`OpenAI synthesis failed: ${response.status} ${error}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  async function synthesizeWithElevenLabs(text: string, options: Options): Promise<Buffer> {
    const key = await getElevenLabsKey()
    const voiceId = options.voice ?? "21m00Tcm4TlvDq8ikWAM"
    const modelId = options.model ?? "eleven_monolingual_v1"

    const response = await fetch(`${ELEVENLABS_URL}/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("elevenlabs synthesis failed", { status: response.status, error })
      throw new Error(`ElevenLabs synthesis failed: ${response.status} ${error}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  async function synthesizeWithSystem(text: string, _options: Options): Promise<Buffer> {
    const platform = process.platform

    if (platform === "darwin") {
      const proc = spawn({
        cmd: ["say", "-o", "-", "--data-format=LEF32@22050", text],
        stdout: "pipe",
        stderr: "pipe",
      })

      const chunks: Uint8Array[] = []
      const reader = proc.stdout.getReader()

      while (true) {
        const result = await reader.read()
        if (result.done) break
        chunks.push(result.value)
      }

      await proc.exited
      return Buffer.concat(chunks)
    }

    if (platform === "linux") {
      const proc = spawn({
        cmd: ["espeak", "-w", "/dev/stdout", text],
        stdout: "pipe",
        stderr: "pipe",
      })

      const chunks: Uint8Array[] = []
      const reader = proc.stdout.getReader()

      while (true) {
        const result = await reader.read()
        if (result.done) break
        chunks.push(result.value)
      }

      await proc.exited
      return Buffer.concat(chunks)
    }

    throw new Error(`system synthesis not supported on ${platform}`)
  }

  async function playAudio(audio: Buffer): Promise<void> {
    const platform = process.platform

    log.info("playing audio", { size: audio.length, platform })

    if (platform === "darwin") {
      const proc = spawn({
        cmd: ["afplay", "-"],
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      })

      proc.stdin.write(audio)
      proc.stdin.end()
      await proc.exited
      return
    }

    if (platform === "linux") {
      const proc = spawn({
        cmd: ["aplay", "-q", "-"],
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      })

      proc.stdin.write(audio)
      proc.stdin.end()
      await proc.exited
      return
    }

    if (platform === "win32") {
      const tempFile = `${process.env.TEMP ?? "/tmp"}/opencode_audio_${Date.now()}.mp3`
      await Bun.write(tempFile, audio)

      const proc = spawn({
        cmd: ["powershell", "-c", `(New-Object Media.SoundPlayer '${tempFile}').PlaySync()`],
        stdout: "ignore",
        stderr: "pipe",
      })

      await proc.exited

      await Bun.file(tempFile)
        .exists()
        .then((exists) => {
          if (exists) {
            return import("fs/promises").then((fs) => fs.unlink(tempFile))
          }
        })
        .catch(() => {})

      return
    }

    log.warn("audio playback not supported on this platform", { platform })
  }

  export async function synthesizeStream(text: string, options: Options = {}): Promise<ReadableStream<Uint8Array>> {
    const provider = options.provider ?? "openai"

    if (provider === "elevenlabs") {
      return synthesizeStreamWithElevenLabs(text, options)
    }

    const audio = await synthesize(text, options)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(audio)
        controller.close()
      },
    })
  }

  async function synthesizeStreamWithElevenLabs(text: string, options: Options): Promise<ReadableStream<Uint8Array>> {
    const key = await getElevenLabsKey()
    const voiceId = options.voice ?? "21m00Tcm4TlvDq8ikWAM"
    const modelId = options.model ?? "eleven_monolingual_v1"

    const response = await fetch(`${ELEVENLABS_URL}/${voiceId}/stream`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("elevenlabs stream synthesis failed", { status: response.status, error })
      throw new Error(`ElevenLabs stream synthesis failed: ${response.status} ${error}`)
    }

    if (!response.body) {
      throw new Error("No response body from ElevenLabs stream")
    }

    return response.body
  }

  export async function checkAvailability(provider: Provider): Promise<{
    available: boolean
    error?: string
  }> {
    if (provider === "openai") {
      const key = await getOpenAIKey().catch(() => null)
      return key ? { available: true } : { available: false, error: "OpenAI API key not configured" }
    }

    if (provider === "elevenlabs") {
      const key = await getElevenLabsKey().catch(() => null)
      return key ? { available: true } : { available: false, error: "ElevenLabs API key not configured" }
    }

    if (provider === "system") {
      const platform = process.platform
      if (platform === "darwin") {
        const proc = spawn({
          cmd: ["which", "say"],
          stdout: "pipe",
          stderr: "pipe",
        })
        const code = await proc.exited
        return code === 0 ? { available: true } : { available: false, error: "say command not found" }
      }

      if (platform === "linux") {
        const proc = spawn({
          cmd: ["which", "espeak"],
          stdout: "pipe",
          stderr: "pipe",
        })
        const code = await proc.exited
        return code === 0
          ? { available: true }
          : { available: false, error: "espeak not found. Install with: apt-get install espeak" }
      }

      return { available: false, error: `system synthesis not supported on ${platform}` }
    }

    return { available: false, error: `unknown provider: ${provider}` }
  }

  export function listOpenAIVoices(): OpenAIVoice[] {
    return ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
  }
}
