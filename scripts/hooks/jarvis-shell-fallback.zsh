# Opt-in only: export JARVIS_SHELL_FALLBACK_ENABLE=1 before sourcing.
if [[ "${JARVIS_SHELL_FALLBACK_ENABLE:-0}" == "1" ]]; then
  jarvis_shell_fallback_event() {
    # Callers provide redacted metadata; this function never reads stdin or keypresses.
    command node "${JARVIS_SHELL_FALLBACK_SCRIPT:-$HOME/.local/lib/jarvis/collect-terminal-evidence.mjs}" <<< "$1"
  }
fi
