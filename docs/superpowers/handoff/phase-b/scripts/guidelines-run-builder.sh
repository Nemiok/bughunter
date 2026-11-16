#!/usr/bin/env bash
# Прогон агента-строителя приёмки гайдлайнов (задача 13, спецификация 6.8).
# Свежий headless-агент получает только поставляемые скиллы, примеры и задание; копия одноразовая.
#
# Модель и конфиг CLI задаются снаружи, чтобы прогон не зависел от недельной квоты Qwen:
#   QBH_CONFIG_DIR (по умолчанию ~/.qwen-deepseek) — отдельный user-level конфиг CLI,
#   QBH_MODEL      (по умолчанию deepseek/deepseek-chat).
set -euo pipefail

ROOT=/Users/nemiok/Desktop/projects/vault/bughunter-phase-b
GR="$ROOT/bughunter-gate/guidelines-check"
G="$GR/project"
TASK="$ROOT/docs/superpowers/handoff/phase-b/scripts/guidelines-task.md"
CONFIG_DIR="${QBH_CONFIG_DIR:-$HOME/.qwen-deepseek}"
MODEL="${QBH_MODEL:-deepseek/deepseek-chat}"

test -d "$G" || { echo "no copy: run guidelines-check.sh first" >&2; exit 1; }
test ! -e "$G/.qwen/bughunter/presets/cli" || { echo "preset already exists: fresh copy required" >&2; exit 1; }

{
  echo "config_dir=$CONFIG_DIR"
  echo "model=$MODEL"
  echo "task=$TASK"
  echo "copy=$G"
} > "$GR/builder.env"

cd "$G"
date -u +%Y-%m-%dT%H:%M:%SZ > "$GR/builder.start"
set +e
caffeinate -i qwen --config-dir "$CONFIG_DIR" -m "$MODEL" \
  -p "$(cat "$TASK")" \
  --output-format stream-json \
  --no-session-persistence \
  --allowed-mcp-server-names bughunter \
  > "$GR/builder.stdout.jsonl" 2> "$GR/builder.stderr.log"
CODE=$?
set -e
date -u +%Y-%m-%dT%H:%M:%SZ > "$GR/builder.end"
echo "builder exit=$CODE"
