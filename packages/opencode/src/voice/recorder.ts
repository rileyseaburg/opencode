import { Log } from "../util/log"
import { spawn, type Subprocess } from "bun"

export namespace Recorder {
  const log = Log.create({ service: "voice.recorder" })

  export interface Options {
    sampleRate?: number
    channels?: number
    device?: string
    onData?: (chunk: Buffer) => void
    onError?: (error: Error) => void
  }

  export interface Instance {
    start(): Promise<void>
    stop(): Promise<void>
    isRecording(): boolean
  }

  const DEFAULT_SAMPLE_RATE = 16000
  const DEFAULT_CHANNELS = 1

  export async function create(options: Options = {}): Promise<Instance> {
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE
    const channels = options.channels ?? DEFAULT_CHANNELS
    const onData = options.onData ?? (() => {})
    const onError = options.onError ?? (() => {})

    const state = {
      recording: false,
      process: null as Subprocess | null,
    }

    async function findRecordingCommand(): Promise<string[]> {
      const platform = process.platform

      if (platform === "darwin") {
        return [
          "sox",
          "-d",
          "-t",
          "raw",
          "-r",
          sampleRate.toString(),
          "-c",
          channels.toString(),
          "-b",
          "16",
          "-e",
          "signed-integer",
          "-",
        ]
      }

      if (platform === "linux") {
        return [
          "arecord",
          "-f",
          "S16_LE",
          "-r",
          sampleRate.toString(),
          "-c",
          channels.toString(),
          "-t",
          "raw",
          "-q",
          "-",
        ]
      }

      if (platform === "win32") {
        return [
          "sox",
          "-t",
          "waveaudio",
          "default",
          "-t",
          "raw",
          "-r",
          sampleRate.toString(),
          "-c",
          channels.toString(),
          "-b",
          "16",
          "-e",
          "signed-integer",
          "-",
        ]
      }

      throw new Error(`unsupported platform: ${platform}`)
    }

    async function start(): Promise<void> {
      if (state.recording) {
        log.warn("already recording")
        return
      }

      const command = await findRecordingCommand()
      log.info("starting recording", { command: command.join(" ") })

      state.recording = true

      const proc = spawn({
        cmd: command,
        stdout: "pipe",
        stderr: "pipe",
      })

      state.process = proc

      const reader = proc.stdout.getReader()

      const readLoop = async () => {
        while (state.recording) {
          const result = await reader.read()
          if (result.done) break
          if (result.value) {
            onData(Buffer.from(result.value))
          }
        }
      }

      readLoop().catch((err) => {
        if (state.recording) {
          log.error("read error", { error: err })
          onError(err instanceof Error ? err : new Error(String(err)))
        }
      })

      const stderrReader = proc.stderr.getReader()
      const stderrLoop = async () => {
        while (state.recording) {
          const result = await stderrReader.read()
          if (result.done) break
          if (result.value) {
            const text = new TextDecoder().decode(result.value)
            if (text.trim()) {
              log.debug("stderr", { text })
            }
          }
        }
      }

      stderrLoop().catch(() => {})
    }

    async function stop(): Promise<void> {
      if (!state.recording) {
        log.warn("not recording")
        return
      }

      log.info("stopping recording")
      state.recording = false

      if (state.process) {
        state.process.kill("SIGTERM")
        await state.process.exited
        state.process = null
      }
    }

    function isRecording(): boolean {
      return state.recording
    }

    return {
      start,
      stop,
      isRecording,
    }
  }

  export async function checkAvailability(): Promise<{
    available: boolean
    command: string
    error?: string
  }> {
    const platform = process.platform
    const command = platform === "darwin" || platform === "win32" ? "sox" : "arecord"

    const proc = spawn({
      cmd: [command, "--version"],
      stdout: "pipe",
      stderr: "pipe",
    })

    const code = await proc.exited

    if (code === 0) {
      return { available: true, command }
    }

    return {
      available: false,
      command,
      error: `${command} not found. Install with: ${getInstallInstructions(platform)}`,
    }
  }

  function getInstallInstructions(platform: string): string {
    if (platform === "darwin") {
      return "brew install sox"
    }
    if (platform === "linux") {
      return "apt-get install alsa-utils (Debian/Ubuntu) or dnf install alsa-utils (Fedora)"
    }
    if (platform === "win32") {
      return "choco install sox or download from https://sox.sourceforge.net/"
    }
    return "install sox or alsa-utils for your platform"
  }
}
