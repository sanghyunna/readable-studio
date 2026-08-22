#!/usr/bin/env bash
# Shared config for the readable-contribute skill.
# TARGET_REPO is hard-locked to sanghyunna/readable-studio — this skill is repository-specific.
#
# Override via env vars before invoking a script:
#   TARGET_FORK   "<owner>/<name>"  push branches here. Defaults to $GH_USER/readable-studio at runtime.
#   READABLE_BASE_BRANCH                   default: main
#   READABLE_WORK_ROOT                     default: $HOME/readable-contrib-work
#   READABLE_DISCORD_INVITE                default: https://discord.gg/qhbcCH8Am4

set -euo pipefail

readonly READABLE_TARGET_REPO="sanghyunna/readable-studio"
TARGET_REPO="$READABLE_TARGET_REPO"

: "${TARGET_FORK:=}"
: "${READABLE_BASE_BRANCH:=main}"
: "${READABLE_WORK_ROOT:="$HOME/readable-contrib-work"}"
: "${READABLE_DISCORD_INVITE:=https://discord.gg/qhbcCH8Am4}"

# Sandboxed-agent fallback for gh auth.
# Codex.app, Cursor, and other macOS App Sandbox runtimes can't reach the
# system keychain where `gh auth login` stores the token by default. If
# GH_TOKEN isn't already set in the env, look for a token file shipped
# alongside the skill. The skill never *creates* this file automatically —
# it must be written by either:
#   - a one-time `gh auth token > <skill>/.gh-token` from a non-sandboxed shell, or
#   - the OAuth Device Flow bootstrap (TODO: implement for non-coder users).
_READABLE_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${GH_TOKEN:-}" && -f "$_READABLE_SKILL_DIR/.gh-token" ]]; then
  GH_TOKEN="$(tr -d '[:space:]' < "$_READABLE_SKILL_DIR/.gh-token")"
  export GH_TOKEN
fi
unset _READABLE_SKILL_DIR

export TARGET_REPO TARGET_FORK READABLE_BASE_BRANCH READABLE_WORK_ROOT READABLE_DISCORD_INVITE

readable::log()  { printf '[readable-contrib] %s\n' "$*" >&2; }
readable::warn() { printf '[readable-contrib][warn] %s\n' "$*" >&2; }
readable::err()  { printf '[readable-contrib][error] %s\n' "$*" >&2; }
readable::die()  { readable::err "$*"; exit 1; }

readable::require() {
  command -v "$1" >/dev/null 2>&1 || readable::die "missing dependency: $1"
}

readable::slugify() {
  local s="${1:-}"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')"
  s="$(printf '%s' "$s" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  printf '%s' "${s:0:48}"
}

readable::workdir_for() {
  # $1 = a slug for this contribution session (e.g. "skill-foo-2026-05-28")
  printf '%s/%s\n' "$READABLE_WORK_ROOT" "$1"
}

# Refuse to operate outside $READABLE_WORK_ROOT (defense against runaway scripts).
readable::assert_in_workroot() {
  local path="$1"
  case "$path" in
    "$READABLE_WORK_ROOT"/*) return 0 ;;
    *) readable::die "refusing to operate on path outside READABLE_WORK_ROOT: $path" ;;
  esac
}
