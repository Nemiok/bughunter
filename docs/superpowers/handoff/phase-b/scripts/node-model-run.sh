#!/usr/bin/env bash
# Одноразовая копия для модельного прогона node-пресета (задача 12).
# Копия размещается ВНЕ .qwen/: CLI относит такие пути к чувствительным и отклоняет запись субагента.
set -euo pipefail

ROOT=/Users/nemiok/Desktop/projects/vault/bughunter-phase-b
GR="$ROOT/bughunter-gate/node-model"
G="$GR/project"

rm -rf "$GR"
mkdir -p "$G"

# 1. Учебный стенд — он же проект копии: экспортированные Vitest-тесты должны попадать в проект
#    с vitest, иначе `placedInProject: false` и red-вердикт не проверить.
rsync -a --exclude node_modules --exclude ACCEPTANCE.md \
  "$ROOT/.qwen/bughunter/fixtures/node-api-app/" "$G/"

# 2. Поставляемое дерево: workspace-корень, core и оба пресета (lockfile требует всех workspaces).
mkdir -p "$G/.qwen/bughunter"
cp "$ROOT/.qwen/bughunter/package.json" "$ROOT/.qwen/bughunter/package-lock.json" \
   "$ROOT/.qwen/bughunter/.gitignore" "$G/.qwen/bughunter/"
rsync -a --exclude node_modules "$ROOT/.qwen/bughunter/core" "$G/.qwen/bughunter/"
rsync -a --exclude node_modules --exclude 'state/runs' --exclude 'state/auth' \
   --exclude 'state/preset.json' --exclude 'state/screens.json' \
  "$ROOT/.qwen/bughunter/presets" "$G/.qwen/bughunter/"

# 3. Промпт-слой: core-скиллы как есть, карта пресета — из node-пресета (имя карты постоянно),
#    агенты — из node-пресета. Точка входа MCP — presets/node/src/index.ts.
mkdir -p "$G/.qwen/agents" "$G/.qwen/skills"
rsync -a "$ROOT/.qwen/skills/" "$G/.qwen/skills/"
cp "$ROOT"/.qwen/bughunter/presets/node/agents/*.md "$G/.qwen/agents/"
cp "$ROOT/.qwen/bughunter/presets/node/skills/preset-card/SKILL.md" \
   "$G/.qwen/skills/bughunter-preset-card/SKILL.md"
cat > "$G/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": [".qwen/bughunter/presets/node/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
JSON

# 4. Точечный allow-list вместо флага обхода проверок разрешений.
#    Deny добавлен после попытки 2: allow-list не ограничивает встроенные инструменты, которых в нём
#    нет, и модель подменила ожидание очереди собственным прогоном Bash/CodeMode (в журнале буквально
#    `sleep 30`, `node -e setTimeout…`, затем цикл опроса в CodeMode). Запрещены все инструменты,
#    способные исполнить код, породить других агентов, выйти в сеть или отложить работу: гейт измеряет
#    оркестрацию протоколом bughunter, а не способность модели обойти его. Запрет делает затор громче,
#    а не тише: выждать его больше нельзя, приходится сообщать. Ни один агент пресета Bash не
#    использует — red-вердикт считает `bh_verify_red` внутри сервера.
cat > "$G/.qwen/settings.json" <<'JSON'
{
  "permissions": {
    "allow": ["mcp__bughunter__*", "Agent", "Skill", "Read", "Grep", "Glob", "Edit", "Write"],
    "deny": [
      "Bash", "CodeMode", "CodeModeWait", "Monitor", "Workflow", "WebFetch",
      "ScheduleWakeup", "CronCreate", "EnterWorktree", "ExitWorktree", "NotebookEdit"
    ]
  }
}
JSON

# 5. Vitest копии не должен видеть ни поставки, ни чужие тесты.
cat > "$G/vitest.config.ts" <<'TS'
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/.qwen/**'] },
});
TS

# 6. Зависимости: один npm ci в корне workspaces ставит core и оба пресета, второй — в стенде.
(cd "$G" && npm ci --no-audit --no-fund > "$GR/install-app.log" 2>&1)
(cd "$G/.qwen/bughunter" && npm ci --no-audit --no-fund > "$GR/install-bughunter.log" 2>&1)

# 7. Корень проекта: bh_start_run ищет .git. Коммит не нужен, достаточно инициализации.
(cd "$G" && git init -q -b main)

# 8. Свободный порт, конфиг копии и стенд.
PORT=$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$PORT" > "$GR/port"

node -e "
const fs = require('node:fs');
const file = '$G/.qwen/bughunter/presets/node/state/config.json';
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.baseUrl = 'http://127.0.0.1:$PORT';
config.allowedHosts = ['127.0.0.1'];
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log('config.json: baseUrl=' + config.baseUrl, 'scenarios=' + config.scenarios.length, 'profile=' + config.profile);
"

cd "$G"
PORT="$PORT" nohup node src/server.js > "$GR/fixture.log" 2>&1 &
FIXTURE_PID=$!
echo "$FIXTURE_PID" > "$GR/fixture.pid"
cd "$ROOT"

for _ in $(seq 1 100); do
  if grep -q "^listening " "$GR/fixture.log" 2>/dev/null; then break; fi
  sleep 0.2
done
echo "fixture pid=$FIXTURE_PID port=$PORT log: $(cat "$GR/fixture.log")"
curl -s -o /dev/null -w "health http %{http_code}\n" "http://127.0.0.1:$PORT/health"

# 9. Состояние разработчика не унаследовано, zod резолвится из workspace-корня копии.
ls "$G/.qwen/bughunter/presets/node/state"
node -e "require('$G/.qwen/bughunter/node_modules/zod'); console.log('zod resolvable from the workspace root')"
ls -l "$G/.qwen/bughunter/node_modules/@bughunter/"
