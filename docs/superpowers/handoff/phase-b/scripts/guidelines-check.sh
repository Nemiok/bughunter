#!/usr/bin/env bash
# Одноразовая копия для приёмки гайдлайнов (задача 13, спецификация 6.8).
#
# Поставляемое дерево кладётся в `toolkit/`, а НЕ в `.qwen/bughunter/`. Причина ровно та, о которой
# предупреждает сам гайд автора пресета (шаг 8): CLI считает записи в `.qwen/` чувствительными и
# отклоняет их без явного одобрения, которого в headless-прогоне нет. Первая попытка приёмки
# (2026-11-16, DeepSeek) упёрлась именно в это: агент создал 21 модуль пресета, а на
# `presets/cli/package.json`, `src/profile.ts` и других файлах получил
# «This file path is sensitive and requires explicit approval» и остановился, не создав точку входа.
# В `.qwen/` остаётся только то, что агенту нужно ЧИТАТЬ: core-скиллы. Их кладёт харнесс.
set -euo pipefail

ROOT=/Users/nemiok/Desktop/projects/vault/bughunter-phase-b
GR="$ROOT/bughunter-gate/guidelines-check"
G="$GR/project"

rm -rf "$GR"
mkdir -p "$G/toolkit" "$G/.qwen/skills"

# 1. Поставляемое дерево как учебный материал: workspace-корень, core и оба пресета
#    (lockfile требует присутствия всех объявленных workspaces). Всё вне `.qwen/`.
cp "$ROOT/.qwen/bughunter/package.json" "$ROOT/.qwen/bughunter/package-lock.json" \
   "$ROOT/.qwen/bughunter/.gitignore" "$G/toolkit/"
rsync -a --exclude node_modules "$ROOT/.qwen/bughunter/core" "$G/toolkit/"
rsync -a --exclude node_modules --exclude 'state/runs' --exclude 'state/auth' \
   --exclude 'state/preset.json' --exclude 'state/screens.json' \
  "$ROOT/.qwen/bughunter/presets" "$G/toolkit/"

# 2. Документация домена: инварианты и гайд автора пресета.
mkdir -p "$G/docs"
rsync -a "$ROOT/docs/concept" "$G/docs/"

# 3. Промпт-слой: core-скиллы как есть. Карта пресета изъята — она пресетная, агент пишет свою
#    внутри своего пресета, а харнесс потом ставит её в `.qwen/skills/bughunter-preset-card`.
rsync -a "$ROOT/.qwen/skills/" "$G/.qwen/skills/"
rm -rf "$G/.qwen/skills/bughunter-preset-card"

# 4. Точка входа MCP настроена с самого начала на путь, которого ещё нет: контракт харнесса —
#    пресет обязан лечь в `toolkit/presets/cli` с входом `src/index.ts`. Абсолютный путь к копии
#    не нужен: CLI запускает сервер с cwd проекта.
cat > "$G/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": ["toolkit/presets/cli/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
JSON

# 5. Разрешения. Здесь агент-строитель: ему нужны Bash (npm, node, запуск собственных тестов) и
#    Write/Edit. Копия одноразовая и изолированная, поэтому точечный allow-list вместо флага
#    обхода. Deny не задаётся: запрет shell сделал бы сборку пресета невозможной, а измеряем мы
#    пригодность гайдлайнов. Правила на пути не задаются — чувствительность `.qwen/` они не
#    снимают, поэтому дерево и вынесено наружу.
cat > "$G/.qwen/settings.json" <<'JSON'
{
  "permissions": {
    "allow": ["mcp__bughunter__*", "Agent", "Skill", "Read", "Grep", "Glob", "Edit", "Write", "Bash"]
  }
}
JSON

# 6. Зависимости поставки. Свой пресет агент регистрирует в `toolkit/package.json` сам — это часть
#    задания. Кэш npm — вне проекта: под ограниченной файловой политикой общий `~/.npm/_cacache`
#    даёт EPERM.
(cd "$G/toolkit" && npm_config_cache="$GR/npm-cache" npm ci --no-audit --no-fund \
  > "$GR/install-bughunter.log" 2>&1)

# 7. Корень проекта: bh_start_run ищет .git. Коммит не нужен, достаточно инициализации.
(cd "$G" && git init -q -b main)

echo "copy ready: $G"
ls "$G" "$G/toolkit" "$G/.qwen/skills"
node -e "require('$G/toolkit/node_modules/zod'); console.log('zod resolvable from the toolkit root')"
