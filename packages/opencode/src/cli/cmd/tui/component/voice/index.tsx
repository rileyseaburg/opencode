import { createSignal, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { EmptyBorder } from "@tui/component/border"
import { createColors, createFrames } from "../../ui/spinner"

export type VoiceState = "idle" | "recording" | "processing" | "speaking"

export type VoiceInputProps = {
  enabled?: boolean
  state?: VoiceState
  transcript?: string
  error?: string | null
  onStart?: () => void
  onStop?: () => void
  onToggle?: () => void
  ref?: (ref: VoiceInputRef) => void
}

export type VoiceInputRef = {
  state: VoiceState
}

const MIC_FRAMES = ["◉", "◎", "○", "◎"]

export function VoiceInput(props: VoiceInputProps) {
  const { theme } = useTheme()

  const [frameIndex, setFrameIndex] = createSignal(0)
  const state = createMemo(() => props.state ?? "idle")
  const enabled = createMemo(() => props.enabled ?? false)

  let animationInterval: NodeJS.Timeout | null = null

  createEffect(() => {
    if (state() === "recording") {
      animationInterval = setInterval(() => {
        setFrameIndex((prev) => (prev + 1) % MIC_FRAMES.length)
      }, 200)
    }
    if (state() !== "recording" && animationInterval) {
      clearInterval(animationInterval)
      animationInterval = null
      setFrameIndex(0)
    }
  })

  onCleanup(() => {
    if (animationInterval) clearInterval(animationInterval)
  })

  props.ref?.({
    get state() {
      return state()
    },
  })

  const stateColor = createMemo(() => {
    switch (state()) {
      case "recording":
        return theme.error
      case "processing":
        return theme.warning
      case "speaking":
        return theme.success
      default:
        return theme.textMuted
    }
  })

  const stateIcon = createMemo(() => {
    switch (state()) {
      case "recording":
        return MIC_FRAMES[frameIndex()]
      case "processing":
        return "⏳"
      case "speaking":
        return "🔊"
      default:
        return "🎤"
    }
  })

  const stateText = createMemo(() => {
    switch (state()) {
      case "recording":
        return "Recording..."
      case "processing":
        return "Processing..."
      case "speaking":
        return "Speaking..."
      default:
        return "Voice"
    }
  })

  const spinnerDef = createMemo(() => ({
    frames: createFrames({
      color: theme.error,
      style: "blocks",
      inactiveFactor: 0.6,
      minAlpha: 0.3,
    }),
    color: createColors({
      color: theme.error,
      style: "blocks",
      inactiveFactor: 0.6,
      minAlpha: 0.3,
    }),
  }))

  return (
    <Show when={enabled()}>
      <box flexDirection="row" gap={1} alignItems="center">
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          border={["left"]}
          borderColor={stateColor()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: "┃",
          }}
        >
          <text fg={stateColor()}>{stateIcon()}</text>
          <text fg={state() === "idle" ? theme.textMuted : theme.text}>{stateText()}</text>
          <Show when={state() === "recording"}>
            {/* @ts-ignore SpinnerOptions typing */}
            <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
          </Show>
        </box>
        <Show when={props.transcript}>
          <box flexShrink={1} maxWidth={40}>
            <text fg={theme.text} wrapMode="word">
              {(props.transcript?.length ?? 0) > 30 ? props.transcript?.slice(0, 30) + "..." : props.transcript}
            </text>
          </box>
        </Show>
        <Show when={props.error}>
          <text fg={theme.error}>{props.error}</text>
        </Show>
        <Show when={state() === "idle"}>
          <text fg={theme.textMuted}>
            v <span style={{ fg: theme.textMuted }}>voice</span>
          </text>
        </Show>
      </box>
    </Show>
  )
}

export type VoiceIndicatorProps = {
  state: VoiceState
  compact?: boolean
}

export function VoiceIndicator(props: VoiceIndicatorProps) {
  const { theme } = useTheme()
  const [frameIndex, setFrameIndex] = createSignal(0)

  let interval: NodeJS.Timeout | null = null

  createEffect(() => {
    if (props.state === "recording") {
      interval = setInterval(() => {
        setFrameIndex((prev) => (prev + 1) % MIC_FRAMES.length)
      }, 200)
    }
    if (props.state !== "recording" && interval) {
      clearInterval(interval)
      interval = null
      setFrameIndex(0)
    }
  })

  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  const color = createMemo(() => {
    switch (props.state) {
      case "recording":
        return theme.error
      case "processing":
        return theme.warning
      case "speaking":
        return theme.success
      default:
        return theme.textMuted
    }
  })

  const icon = createMemo(() => {
    switch (props.state) {
      case "recording":
        return MIC_FRAMES[frameIndex()]
      case "processing":
        return "⏳"
      case "speaking":
        return "🔊"
      default:
        return "🎤"
    }
  })

  return (
    <Show when={props.state !== "idle"}>
      <box flexDirection="row" gap={1}>
        <text fg={color()}>{icon()}</text>
        <Show when={!props.compact}>
          <text fg={color()}>{props.state === "recording" ? "REC" : props.state === "processing" ? "..." : "♪"}</text>
        </Show>
      </box>
    </Show>
  )
}

export function PushToTalkOverlay(props: { active: boolean; onRelease?: () => void }) {
  const { theme } = useTheme()
  const [frameIndex, setFrameIndex] = createSignal(0)

  const MIC_RECORDING_FRAMES = ["🔴", "⭕", "🔴", "⭕"]

  let interval: NodeJS.Timeout | null = null

  createEffect(() => {
    if (props.active) {
      interval = setInterval(() => {
        setFrameIndex((prev) => (prev + 1) % MIC_RECORDING_FRAMES.length)
      }, 150)
    }
    if (!props.active && interval) {
      clearInterval(interval)
      interval = null
      setFrameIndex(0)
    }
  })

  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  return (
    <Show when={props.active}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        alignItems="center"
        justifyContent="center"
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={theme.error}>{MIC_RECORDING_FRAMES[frameIndex()]}</text>
          <text fg={theme.text}>Recording... Release space to stop</text>
          <box flexDirection="row" gap={2} marginTop={1}>
            <text fg={theme.textMuted}>Hold space for push-to-talk</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

export function useVoiceState() {
  const [store, setStore] = createStore<{
    state: VoiceState
    transcript: string
    error: string | null
  }>({
    state: "idle",
    transcript: "",
    error: null,
  })

  return {
    get state() {
      return store.state
    },
    get transcript() {
      return store.transcript
    },
    get error() {
      return store.error
    },
    setState(state: VoiceState) {
      setStore("state", state)
    },
    setTranscript(text: string) {
      setStore("transcript", text)
    },
    setError(error: string | null) {
      setStore("error", error)
    },
    start() {
      setStore("state", "recording")
      setStore("transcript", "")
      setStore("error", null)
    },
    stop() {
      setStore("state", "processing")
    },
    complete(transcript: string) {
      setStore("transcript", transcript)
      setStore("state", "idle")
    },
    fail(error: string) {
      setStore("error", error)
      setStore("state", "idle")
    },
    reset() {
      setStore("state", "idle")
      setStore("transcript", "")
      setStore("error", null)
    },
  }
}
