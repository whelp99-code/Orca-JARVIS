#!/usr/bin/env bash
set -euo pipefail

readonly STATE_ROOT="/home/jm/.local/state/second-brain"
readonly APP_ROOT="${STATE_ROOT}/app"
readonly CURRENT="${APP_ROOT}/current"
readonly RELEASES="${APP_ROOT}/releases"
readonly CONFIG="/home/jm/.config/second-brain/jarvis-provider.toml"

release="$(readlink -f -- "${CURRENT}")"
releases="$(readlink -f -- "${RELEASES}")"
if [[ -z "${release}" || -z "${releases}" || "$(dirname -- "${release}")" != "${releases}" ]]; then
  printf 'SECOND_BRAIN_REFRESH_RELEASE_INVALID\n' >&2
  exit 1
fi

readonly CLI="${CURRENT}/bin/sb"
if [[ ! -x "${CLI}" || ! -f "${CONFIG}" ]]; then
  printf 'SECOND_BRAIN_REFRESH_NOT_READY\n' >&2
  exit 1
fi

export SB_CONFIG="${CONFIG}"
exec "${CLI}" run