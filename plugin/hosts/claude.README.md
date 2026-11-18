# Bughunter как Claude-плагин

Плагин ставит Bughunter нативно для Claude Code CLI и Desktop Code sessions: собирает сервер, регистрирует его как plugin MCP-сервер, включает промпт-слой и после выбора пресета создаёт opt-in-файл проекта. Копировать дерево и писать MCP-конфигурацию вручную не нужно.

Проверено нативным гейтом `npm run test:claude-marketplace` против Claude Code CLI 2.1.327 (`claude plugin validate --strict`, `plugin marketplace add`, `plugin install`, `plugin list`, `plugin marketplace update`, `plugin update` во временных `CLAUDE_CONFIG_DIR` и `HOME`, без входа в аккаунт и без model turns): strict-валидация артефакта, установка из custom marketplace со статусом enabled, dormant-режим (ровно `bh_setup`), 19 web- и 16 node-инструментов на новом процессе сервера, обновление на `0.1.1-test.1` по обоим полям версии с сохранением состояния проекта. Нужны Node.js ≥ 22.18 и Git в целевом проекте; для веб-пресета — установленный Google Chrome.

## Установка

1. `/plugin marketplace add <configured-source>` один раз, затем `/plugin install bughunter@bughunter-market`.
2. Выбрать user scope, открыть local CLI/Desktop Code session и при необходимости выполнить `/reload-plugins`.
3. Вызвать `/bughunter:bughunter`, явно выбрать web/node и заполнить `.claude/bughunter/state/<preset>/config.json`.
4. Начать с `/bughunter:bughunter target /orders`, подставив route из `routes`.
5. Проверить `.claude/bughunter/state/<preset>/runs/<runId>/report.md`.

Первый запуск после выбора пресета вернёт `CONFIG_CREATED` с путём к `config.json`; заполните его и запустите skill снова.

## Пресеты

Проект выбирает один пресет через `.claude/bughunter.json`:

```json
{ "preset": "web" }
```

или

```json
{ "preset": "node" }
```

- `web` — маршруты и экраны, Playwright/Chrome, `baseUrl`, `allowedOrigins`, `routes`, `targetMap`; профиль необязателен.
- `node` — HTTP-API, эндпоинты и сценарии; `profile` обязателен, `scenarios` объявляют ожидания, `reset` возвращает стенд в исходное состояние.

Оба пресета входят в плагин, но сервер запускает только выбранный. Один проект — один пресет. Смена пресета: отредактируйте `.claude/bughunter.json` и выполните `/reload-plugins`. Инструменты в сессии называются `mcp__plugin_bughunter_bughunter__*`.

## Где состояние

```text
.claude/bughunter/state/<preset>/
  config.json
  profiles/
  runs/
  auth/
  preset.json
```

`state/<preset>/.gitignore` игнорирует `runs/` и `auth/`. `config.json`, `profiles/`, `preset.json`, `known-bugs.json` и `suppressions.json` можно версионировать.

Без `.claude/bughunter.json` плагин находится в **dormant**-режиме: MCP-сервер подключается и отдаёт только `bh_setup`; состояние в проекте не создаётся до первого setup. Это защищает чужие проекты, где Bughunter не нужен.

## Авторизация веб-стенда

```sh
BUGHUNTER_STATE_DIR="$PWD/.claude/bughunter/state/web" \
  node "<installPath>/server/presets/web/src/auth.ts"
```

Скрипт открывает headed Chrome по `baseUrl` из конфига, после входа сохраняет `state/web/auth/storage-state.json` — туда, откуда его читает сессия. `<installPath>` — каталог установленного плагина.

## Ограничения

- Claude Desktop chat и claude.ai не заявлены как local MCP targets: поддерживаются локальные сессии Claude Code CLI и Desktop Code. Полная поддержка Desktop — только Desktop Code local session и требует гейта Task 14.
- Схема `.claude-plugin/plugin.json` и marketplace-формат зафиксированы artifact-тестом, а жизненный цикл install/update — нативным гейтом на Claude Code CLI 2.1.327; поведение других сборок Claude Code CLI/Desktop при подключении marketplace source может отличаться — проверяйте на своей версии.
- Сервер стартует при каждой сессии в любом проекте; в проектах без opt-in он dormant и не создаёт файлов.
- Плагин — снимок дерева Bughunter. После изменений в core/пресетах пересоберите и обновите его.
- Центральной публикации нет; конкретный способ распространения marketplace должен задать publisher.
