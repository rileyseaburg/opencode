import { Log } from "../util/log"
import { Auth } from "../auth"
import { Env } from "../env"

export namespace Transcriber {
  const log = Log.create({ service: "voice.transcriber" })

  export type Provider = "openai" | "google" | "deepgram" | "local"

  export interface Options {
    provider?: Provider
    language?: string
    model?: string
  }

  const OPENAI_WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions"
  const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"
  const GOOGLE_STT_URL = "https://generativelanguage.googleapis.com/v1beta/models"

  async function getOpenAIKey(): Promise<string> {
    const envKey = Env.get("OPENAI_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("openai")
    if (auth?.type === "api") return auth.key

    throw new Error("OpenAI API key not found. Set OPENAI_API_KEY or authenticate with openai provider.")
  }

  async function getGoogleKey(): Promise<string> {
    const envKey = Env.get("GOOGLE_API_KEY") || Env.get("GEMINI_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("google")
    if (auth?.type === "api") return auth.key

    throw new Error("Google API key not found. Set GOOGLE_API_KEY or authenticate with google provider.")
  }

  async function getDeepgramKey(): Promise<string> {
    const envKey = Env.get("DEEPGRAM_API_KEY")
    if (envKey) return envKey

    const auth = await Auth.get("deepgram")
    if (auth?.type === "api") return auth.key

    throw new Error("Deepgram API key not found. Set DEEPGRAM_API_KEY or authenticate with deepgram provider.")
  }

  export async function transcribe(audio: Buffer, options: Options = {}): Promise<string> {
    const provider = options.provider ?? "google"

    log.info("transcribing", { provider, size: audio.length })

    if (provider === "google") {
      return transcribeWithGoogle(audio, options)
    }

    if (provider === "openai") {
      return transcribeWithOpenAI(audio, options)
    }

    if (provider === "deepgram") {
      return transcribeWithDeepgram(audio, options)
    }

    if (provider === "local") {
      return transcribeLocal(audio, options)
    }

    throw new Error(`unsupported transcription provider: ${provider}`)
  }

  async function transcribeWithGoogle(audio: Buffer, options: Options): Promise<string> {
    const key = await getGoogleKey()
    const model = options.model ?? "gemini-2.0-flash"

    const base64Audio = audio.toString("base64")

    const response = await fetch(`${GOOGLE_STT_URL}/${model}:generateContent?key=${key}`, {
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
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("google transcription failed", { status: response.status, error })
      throw new Error(`Google transcription failed: ${response.status} ${error}`)
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

    return result.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  }

  async function transcribeWithOpenAI(audio: Buffer, options: Options): Promise<string> {
    const key = await getOpenAIKey()
    const model = options.model ?? "whisper-1"

    const formData = new FormData()
    formData.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav")
    formData.append("model", model)

    if (options.language) {
      formData.append("language", options.language)
    }

    const response = await fetch(OPENAI_WHISPER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("openai transcription failed", { status: response.status, error })
      throw new Error(`OpenAI transcription failed: ${response.status} ${error}`)
    }

    const result = (await response.json()) as { text: string }
    return result.text
  }

  async function transcribeWithDeepgram(audio: Buffer, options: Options): Promise<string> {
    const key = await getDeepgramKey()

    const params = new URLSearchParams({
      model: options.model ?? "nova-2",
      smart_format: "true",
    })

    if (options.language) {
      params.set("language", options.language)
    }

    const response = await fetch(`${DEEPGRAM_URL}?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(audio),
    })

    if (!response.ok) {
      const error = await response.text()
      log.error("deepgram transcription failed", { status: response.status, error })
      throw new Error(`Deepgram transcription failed: ${response.status} ${error}`)
    }

    const result = (await response.json()) as {
      results: {
        channels: Array<{
          alternatives: Array<{
            transcript: string
          }>
        }>
      }
    }

    return result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ""
  }

  async function transcribeLocal(audio: Buffer, options: Options): Promise<string> {
    log.warn("local transcription not yet implemented, falling back to openai")
    return transcribeWithOpenAI(audio, options)
  }

  export async function transcribeStream(
    stream: ReadableStream<Uint8Array>,
    options: Options = {},
  ): Promise<AsyncGenerator<string>> {
    const provider = options.provider ?? "openai"

    if (provider === "deepgram") {
      return transcribeStreamWithDeepgram(stream, options)
    }

    const chunks: Uint8Array[] = []
    const reader = stream.getReader()

    while (true) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    const audio = Buffer.concat(chunks)
    const text = await transcribe(audio, options)

    return (async function* () {
      yield text
    })()
  }

  async function* transcribeStreamWithDeepgram(
    stream: ReadableStream<Uint8Array>,
    options: Options,
  ): AsyncGenerator<string> {
    const key = await getDeepgramKey()

    const params = new URLSearchParams({
      model: options.model ?? "nova-2",
      smart_format: "true",
      interim_results: "true",
    })

    if (options.language) {
      params.set("language", options.language)
    }

    const wsUrl = `wss://api.deepgram.com/v1/listen?${params}`
    const ws = new WebSocket(wsUrl)

    const messages: string[] = []
    const waiting: Array<{
      resolve: (value: IteratorResult<string>) => void
      reject: (error: Error) => void
    }> = []
    const closed = { value: false }

    const authMessage = { type: "Configure", token: key }

    ws.onopen = () => {
      ws.send(JSON.stringify(authMessage))
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(String(event.data)) as {
        channel?: {
          alternatives?: Array<{
            transcript?: string
          }>
        }
        is_final?: boolean
      }

      const transcript = data.channel?.alternatives?.[0]?.transcript
      if (transcript && data.is_final) {
        if (waiting.length > 0) {
          const waiter = waiting.shift()!
          waiter.resolve({ value: transcript, done: false })
        }
        messages.push(transcript)
      }
    }

    ws.onerror = () => {
      log.error("deepgram websocket error")
      closed.value = true
      for (const waiter of waiting) {
        waiter.reject(new Error("WebSocket error"))
      }
    }

    ws.onclose = () => {
      closed.value = true
      for (const waiter of waiting) {
        waiter.resolve({ value: "", done: true })
      }
    }

    await new Promise<void>((resolve) => {
      const original = ws.onopen
      ws.onopen = (event) => {
        if (original) original.call(ws, event)
        resolve()
      }
    })

    const reader = stream.getReader()
    const sendLoop = async () => {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(result.value)
        }
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    }

    sendLoop().catch((err) => {
      log.error("send loop error", { error: err })
    })

    while (!closed.value || messages.length > 0) {
      if (messages.length > 0) {
        yield messages.shift()!
        continue
      }

      if (closed.value) break

      const result = await new Promise<IteratorResult<string>>((resolve, reject) => {
        waiting.push({ resolve, reject })
      })

      if (result.done) break
      yield result.value
    }
  }
}
