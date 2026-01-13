import z from "zod"
import type { ZodType } from "zod"
import { Log } from "../util/log"

export namespace BusEvent {
  const log = Log.create({ service: "event" })

  export type Definition = ReturnType<typeof define>

  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    const result = {
      type,
      properties,
    }
    registry.set(type, result)
    return result
  }

  export function payloads() {
    return z
      .discriminatedUnion(
        "type",
        registry
          .entries()
          .map(([type, def]) => {
            return z
              .object({
                type: z.literal(type),
                properties: def.properties,
              })
              .meta({
                ref: "Event" + "." + def.type,
              })
          })
          .toArray() as any,
      )
      .meta({
        ref: "Event",
      })
  }
}

export namespace Voice {
  export const Event = {
    RecordingStarted: BusEvent.define(
      "voice.recording.started",
      z.object({
        sessionID: z.string(),
      }),
    ),
    RecordingStopped: BusEvent.define(
      "voice.recording.stopped",
      z.object({
        sessionID: z.string(),
        audioRef: z.string(),
        durationMs: z.number(),
      }),
    ),
    TranscriptionStarted: BusEvent.define(
      "voice.transcription.started",
      z.object({
        sessionID: z.string(),
        audioRef: z.string(),
      }),
    ),
    TranscriptionCompleted: BusEvent.define(
      "voice.transcription.completed",
      z.object({
        sessionID: z.string(),
        audioRef: z.string(),
        transcript: z.string(),
      }),
    ),
    SynthesisStarted: BusEvent.define(
      "voice.synthesis.started",
      z.object({
        sessionID: z.string(),
        text: z.string(),
      }),
    ),
    SynthesisCompleted: BusEvent.define(
      "voice.synthesis.completed",
      z.object({
        sessionID: z.string(),
        audioRef: z.string(),
        durationMs: z.number(),
      }),
    ),
    Error: BusEvent.define(
      "voice.error",
      z.object({
        sessionID: z.string().optional(),
        operation: z.enum(["recording", "transcription", "synthesis"]),
        error: z.string(),
      }),
    ),
  }
}
