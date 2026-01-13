import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"

export type DialogVoiceConfigProps = {
  enabled: boolean
  sttProvider: string
  ttsProvider: string
  ttsVoice: string
  autoSpeak: boolean
}

export function DialogVoiceConfig(props: DialogVoiceConfigProps) {
  const { theme } = useTheme()

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Voice Configuration
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted} flexShrink={0}>
            Status:
          </text>
          <text fg={props.enabled ? theme.success : theme.textMuted}>{props.enabled ? "Enabled" : "Disabled"}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted} flexShrink={0}>
            Speech-to-Text:
          </text>
          <text fg={theme.text}>{props.sttProvider}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted} flexShrink={0}>
            Text-to-Speech:
          </text>
          <text fg={theme.text}>{props.ttsProvider}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted} flexShrink={0}>
            TTS Voice:
          </text>
          <text fg={theme.text}>{props.ttsVoice}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted} flexShrink={0}>
            Auto-Speak:
          </text>
          <text fg={props.autoSpeak ? theme.success : theme.textMuted}>{props.autoSpeak ? "On" : "Off"}</text>
        </box>
      </box>
      <box marginTop={1}>
        <text fg={theme.textMuted}>Configure voice settings in opencode.json:</text>
        <text fg={theme.text}>{"{"}</text>
        <text fg={theme.text}>{`  "voice": {`}</text>
        <text fg={theme.text}>{`    "enabled": true,`}</text>
        <text fg={theme.text}>{`    "sttProvider": "openai",`}</text>
        <text fg={theme.text}>{`    "ttsProvider": "openai",`}</text>
        <text fg={theme.text}>{`    "ttsVoice": "alloy",`}</text>
        <text fg={theme.text}>{`    "autoSpeak": false`}</text>
        <text fg={theme.text}>{`  }`}</text>
        <text fg={theme.text}>{"}"}</text>
      </box>
    </box>
  )
}
