#!/usr/bin/env bash
# Одноразовая копия для приёмки гайдлайнов (задача 13, спецификация 6.8).
# Копия размещается ВНЕ .qwen/: CLI относит такие пути к чувствительным и отклоняет запись субагента.
#
# Смысл гейта: свежий агент, у которого есть ТОЛЬКО поставляемые скиллы и примеры, собирает пресет
# для нового вида цели. Всё, что ему пришлось угадать, — дефект гайдлайнов, а не агента.
# Поэтому копия намеренно не содержит ни заготовки `presets/cli`, ни мини-фикстуры `cli-app`.
set -euo pipefail

ROOT=/Users/nemiok/Desktop/projects/vault/bughunter-phase-b
GR="$ROOT/bughunter-gate/guidelines-check"
G="$GR/project"

rm -rf "$GR"
mkdir -p "$G/.qwen/bughunter" "$G/.qwen/skills" "$G/.qwen/agents"

# 1. Поставляемое дерево как учебный материал: workspace-корень, core и оба пресета
#    (lockfile требует присутствия всех объявленных workspaces).
cp "$ROOT/.qwen/bughunter/package.json" "$ROOT/.qwen/bughunter/package-lock.json" \
   "$ROOT/.qwen/bughunter/.gitignore" "$G/.qwen/bughunter/"
rsync -a --exclude node_modules "$ROOT/.qwen/bughunter/core" "$G/.qwen/bughunter/"
rsync -a --exclude node_modules --exclude 'state/runs' --exclude 'state/auth' \
   --exclude 'state/preset.json' --exclude 'state/screens.json' \
  "$ROOT/.qwen/bughunter/presets" "$G/.qwen/bughunter/"

# 2. Документация домена: инварианты и гайд автора пресета.
mkdir -p "$G/docs"
rsync -a "$ROOT/docs/concept" "$G/docs/"

# 3. Промпт-слой: core-скиллы как есть. Карта пресета изъята — она пресетная, агент пишет свою.
rsync -a "$ROOT/.qwen/skills/" "$G/.qwen/skills/"
rm -rf "$G/.qwen/skills/bughunter-preset-card"

# 4. Точка входа MCP настроена с самого начала на путь, которого ещё нет: контракт харнесса —
#    пресет обязан лечь в `presets/cli` с входом `src/index.ts`.
cat > "$G/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": [".qwen/bughunter/presets/cli/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
JSON

# 5. Разрешения. В отличие от модельного прогона node-пресета здесь агент-строитель: ему нужны
#    Bash (npm, node, запуск собственных тестов) и Write/Edit. Копия одноразовая и изолированная,
#    поэтому точечный allow-list вместо флага обхода. Deny не задаётся намеренно: запрет shell
#    сделал бы сборку пресета невозможной, а измеряем мы здесь пригодность гайдлайнов.
cat > "$G/.qwen/settings.json" <<'JSON'
{
  "permissions": {
    "allow": ["mcp__bughunter__*", "Agent", "Skill", "Read", "Grep", "Glob", "Edit", "Write", "Bash"]
  }
}
JSON

# 6. Зависимости поставки. Свой пресет агент регистрирует в workspaces сам — это часть задания.
(cd "$G/.qwen/bughunter" && npm ci --no-audit --no-fund > "$GR/install-bughunter.log" 2>&1)

# 7. Корень проекта: bh_start_run ищет .git. Коммит не нужен, достаточно инициализации.
(cd "$G" && git init -q -b main)

echo "copy ready: $G"
ls "$G" "$G/.qwen" "$G/.qwen/bughunter" "$G/.qwen/skills"
node -e "require('$G/.qwen/bughunter/node_modules/zod'); console.log('zod resolvable from the workspace root')"
