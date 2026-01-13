import z from "zod"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Instance } from "../project/instance"

export namespace Voice {
  const log = Log.create({ service: "voice" })

  export const RecordingStarted = BusEvent.define(
    "voice.recording.started",
    z.object({
      timestamp: z.number(),
    }),
  )

  export const RecordingStopped = BusEvent.define(
    "voice.recording.stopped",
    z.object({
      timestamp: z.number(),
      duration: z.number(),
    }),
  )

  export const TranscriptionStarted = BusEvent.define(
    "voice.transcription.started",
    z.object({
      timestamp: z.number(),
    }),
  )

  export const TranscriptionCompleted = BusEvent.define(
    "voice.transcription.completed",
    z.object({
      timestamp: z.number(),
      text: z.string(),
      duration: z.number(),
    }),
  )

  export const SynthesisStarted = BusEvent.define(
    "voice.synthesis.started",
    z.object({
      timestamp: z.number(),
      text: z.string(),
    }),
  )

  export const SynthesisCompleted = BusEvent.define(
    "voice.synthesis.completed",
    z.object({
      timestamp: z.number(),
      duration: z.number(),
    }),
  )

  export const Error = BusEvent.define(
    "voice.error",
    z.object({
      timestamp: z.number(),
      message: z.string(),
      operation: z.enum(["recording", "transcription", "synthesis"]),
    }),
  )

  interface RecorderInstance {
    start(): Promise<void>
    stop(): Promise<void>
    isRecording(): boolean
  }

  const state = Instance.state(() => {
    return {
      recording: false,
      startTime: 0,
      chunks: [] as Buffer[],
      recorder: null as RecorderInstance | null,
    }
  })

  export async function startRecording(): Promise<void> {
    const s = state()
    if (s.recording) {
      log.warn("recording already in progress")
      return
    }

    const { Recorder } = await import("./recorder")

    log.info("starting recording")

    s.recording = true
    s.startTime = Date.now()
    s.chunks = []

    s.recorder = await Recorder.create({
      onData: (chunk: Buffer) => {
        s.chunks.push(chunk)
      },
      onError: (error: Error) => {
        log.error("recording error", { error })
        Bus.publish(Voice.Error, {
          timestamp: Date.now(),
          message: error.message,
          operation: "recording",
        })
      },
    })

    await s.recorder.start()

    await Bus.publish(Voice.RecordingStarted, {
      timestamp: s.startTime,
    })
  }

  export async function stopRecording(): Promise<Buffer> {
    const s = state()
    if (!s.recording) {
      log.warn("no recording in progress")
      return Buffer.alloc(0)
    }

    log.info("stopping recording")

    if (s.recorder) {
      await s.recorder.stop()
      s.recorder = null
    }

    const duration = Date.now() - s.startTime
    const audio = Buffer.concat(s.chunks)

    s.recording = false
    s.startTime = 0
    s.chunks = []

    await Bus.publish(Voice.RecordingStopped, {
      timestamp: Date.now(),
      duration,
    })

    return audio
  }

  export function isRecording(): boolean {
    return state().recording
  }

  export async function transcribe(audio: Buffer): Promise<string> {
    const { Transcriber } = await import("./transcriber")
    const startTime = Date.now()

    log.info("starting transcription", { size: audio.length })

    await Bus.publish(Voice.TranscriptionStarted, {
      timestamp: startTime,
    })

    const text = await Transcriber.transcribe(audio, {
      provider: "openai",
    })

    const duration = Date.now() - startTime

    await Bus.publish(Voice.TranscriptionCompleted, {
      timestamp: Date.now(),
      text,
      duration,
    })

    log.info("transcription completed", { duration, length: text.length })

    return text
  }

  export async function speak(text: string): Promise<void> {
    const { Synthesizer } = await import("./synthesizer")
    const startTime = Date.now()

    log.info("starting synthesis", { length: text.length })

    await Bus.publish(Voice.SynthesisStarted, {
      timestamp: startTime,
      text,
    })

    await Synthesizer.speak(text, {
      provider: "openai",
      voice: "alloy",
    })

    const duration = Date.now() - startTime

    await Bus.publish(Voice.SynthesisCompleted, {
      timestamp: Date.now(),
      duration,
    })

    log.info("synthesis completed", { duration })
  }

  export async function recordAndTranscribe(): Promise<string> {
    const audio = await stopRecording()
    if (audio.length === 0) {
      return ""
    }
    return transcribe(audio)
  }
}

export { Recorder } from "./recorder"
export { Transcriber } from "./transcriber"
export { Synthesizer } from "./synthesizer"
