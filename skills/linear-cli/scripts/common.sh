#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

append_workspace_args() {
  local ref_name="$1"
  if [[ ! "${ref_name}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "Invalid array reference: ${ref_name}" >&2
    exit 1
  fi
  if [[ -z "${LINEAR_API_KEY:-}" && -n "${LINEAR_WORKSPACE:-}" ]]; then
    eval "${ref_name}+=(\"-w\" \"\${LINEAR_WORKSPACE}\")"
  fi
}

append_team_args() {
  local ref_name="$1"
  if [[ ! "${ref_name}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "Invalid array reference: ${ref_name}" >&2
    exit 1
  fi
  require_env "LINEAR_TEAM_KEY"
  eval "${ref_name}+=(\"--team\" \"\${LINEAR_TEAM_KEY}\")"
}
