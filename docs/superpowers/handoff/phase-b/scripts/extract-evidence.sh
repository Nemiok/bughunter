#!/usr/bin/env bash
# Изъятие доказательств модельного прогона из одноразовой копии до её удаления.
# Использование: extract-evidence.sh <runId> <имя-каталога-доказательств> [префикс-jsonl ...]
set -euo pipefail

ROOT=/Users/nemiok/Desktop/projects/vault/bughunter-phase-b
GR="$ROOT/bughunter-gate/node-model"
G="$GR/project"
RUN="$1"
DEST="$ROOT/.qwen/bughunter/presets/node/state/runs/$2"
shift 2

SRC="$G/.qwen/bughunter/presets/node/state/runs/$RUN"
test -d "$SRC" || { echo "нет каталога прогона: $SRC" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a "$SRC/" "$DEST/run/"

# Журналы CLI и обвязка гейта.
for prefix in "$@"; do
  for file in "$GR/$prefix".stdout.jsonl "$GR/$prefix".stderr.log "$GR/$prefix".start "$GR/$prefix".end; do
    test -e "$file" && cp "$file" "$DEST/"
  done
done
for file in "$GR/port" "$GR/fixture.log" "$GR/probe3.jsonl" "$GR/probe4.jsonl" \
            "$GR/install-app.log" "$GR/install-bughunter.log"; do
  test -e "$file" && cp "$file" "$DEST/"
done
cp "$G/.qwen/settings.json" "$DEST/gate-settings.json"
cp "$G/.mcp.json" "$DEST/gate-mcp.json"

# Общая память пресета и экспортированные тесты живут вне каталога прогона.
STATE="$G/.qwen/bughunter/presets/node/state"
for file in known-bugs.json suppressions.json; do
  test -e "$STATE/$file" && cp "$STATE/$file" "$DEST/"
done
if test -d "$G/test"; then
  mkdir -p "$DEST/exported-tests"
  rsync -a "$G/test/" "$DEST/exported-tests/"
fi

echo "evidence -> $DEST"
find "$DEST" -maxdepth 2 -type d | sed "s|$DEST|.|"
du -sh "$DEST"
