# Bughunter как Kimi-плагин

Плагин ставит Bughunter нативно для Kimi Code CLI и Desktop: собирает сервер, регистрирует его как plugin MCP-сервер, включает промпт-слой и после выбора пресета создаёт opt-in-файл проекта. Копировать дерево и писать MCP-конфигурацию вручную не нужно.

Проверено на схеме плагина Kimi (`kimi.plugin.json`, custom marketplace версии `2`, клиенты `cli` и `desktop`) против реального локального сервера Kimi Code CLI 2.5.3 (`kimi web`, REST `/api/v1/*`): установка, 7 скиллов/1 MCP-сервер/0 диагностик, dormant-режим, 19 web- и 16 node-инструментов, обновление на `0.1.1-test.1` с сохранением состояния проекта. Нужны Node.js ≥ 22.18 и Git в целевом проекте; для веб-пресета — установленный Google Chrome.

Поведение хоста, зафиксированное прогоном (не предположениями):

- Плагинный MCP-сервер запускается с `cwd` = каталог установленного плагина (`$KIMI_CODE_HOME/plugins/managed/<id>`), переменные в `args` не раскрываются, путь к скрипту в манифесте относительный: `./server/mcp.mjs`.
- Клиент MCP присылает пустые capabilities — рабочий каталог сессии серверу не передаётся. Мост — `SessionStart`-хук плагина: он записывает cwd сессии в `$KIMI_CODE_HOME/bughunter/session-cwd`, лаунчер читает его при старте. Инструменты в сессии именуются `mcp__plugin-bughunter_bughunter__*`; после `bh_setup` MCP-сервер перечитывается (`/reload` или рестарт MCP-сервера), без этого новая сессия видит прежний набор.
- Обновление — повторный `POST /api/v1/plugins` с новым `expectedVersion`: managed-копия заменяется, файлы состояния проекта (`.kimi-code/bughunter/state/`, opt-in) не трогаются.
- Marketplace принимает `platforms` в обоих написаниях: `macos`/`windows`/`linux`/`cloud` и их алиасы `darwin`/`win32`; сравнение идёт с `process.platform`.

## Установка

1. Settings → Plugins → добавить custom marketplace JSON.
2. Установить `bughunter`, затем выполнить `/reload` или открыть новую сессию.
3. В проекте вызвать `/skill:bughunter:bughunter`, выбрать web/node и заполнить `.kimi-code/bughunter/state/<preset>/config.json`.
4. После заполнения повторить `/skill:bughunter:bughunter target /orders`, заменив route на значение из `routes`.
5. Проверить `.kimi-code/bughunter/state/<preset>/runs/<runId>/report.md`.

Первый запуск после выбора пресета вернёт `CONFIG_CREATED` с путём к `config.json`; заполните его и запустите skill снова.

## Пресеты

Проект выбирает один пресет через `.kimi-code/bughunter.json`:

```json
{ "preset": "web" }
```

или

```json
{ "preset": "node" }
```

- `web` — маршруты и экраны, Playwright/Chrome, `baseUrl`, `allowedOrigins`, `routes`, `targetMap`; профиль необязателен.
- `node` — HTTP-API, эндпоинты и сценарии; `profile` обязателен, `scenarios` объявляют ожидания, `reset` возвращает стенд в исходное состояние.

Оба пресета входят в плагин, но сервер запускает только выбранный. Один проект — один пресет. Смена пресета: отредактируйте `.kimi-code/bughunter.json` и выполните `/reload` или откройте новую сессию.

## Где состояние

```text
.kimi-code/bughunter/state/<preset>/
  config.json
  profiles/
  runs/
  auth/
  preset.json
```

`state/<preset>/.gitignore` игнорирует `runs/` и `auth/`. `config.json`, `profiles/`, `preset.json`, `known-bugs.json` и `suppressions.json` можно версионировать.

Без `.kimi-code/bughunter.json` плагин находится в **dormant**-режиме: MCP-сервер подключается и отдаёт только `bh_setup`; состояние в проекте не создаётся до первого setup. Это защищает чужие проекты, где Bughunter не нужен.

## Авторизация веб-стенда

```sh
BUGHUNTER_STATE_DIR="$PWD/.kimi-code/bughunter/state/web" \
  node <installPath>/server/presets/web/src/auth.ts
```

Скрипт открывает headed Chrome по `baseUrl` из конфига, после входа сохраняет `state/web/auth/storage-state.json` — туда, откуда его читает сессия. `<installPath>` — каталог установленного плагина в кэше Kimi.

## Авторство нового пресета

В плагин входят авторские скиллы `bughunter:bughunter-preset-guide` и
`bughunter:bughunter-core-contract`, рабочий шаблон CLI-пресета и бриф. Порядок работы —
`<installPath>/AUTHORING.md`, шаблон — `<installPath>/template/cli-preset`, бриф —
`<installPath>/template/authoring-brief.md`.

## Обновление и удаление

Обновите плагин через Settings → Plugins и повторите `/reload`. Удаление плагина не удаляет `.kimi-code/bughunter.json` и `.kimi-code/bughunter/state/`; уберите их вручную, если состояние больше не нужно.

## Сборка и проверка

```sh
node plugin/build.mjs --host all            # собрать Qwen- и Kimi-артефакты из одного staged payload
npm --prefix plugin test                    # в том числе artifact-тест Kimi
npm --prefix plugin run test:kimi-marketplace  # жизненный цикл Kimi против реального `kimi web` (изолированный KIMI_CODE_HOME)
```

`plugin/dist/` — генерируемый каталог, в Git не попадает. Custom marketplace в этой инструкции — локальный JSON-каталог, который оператор добавляет вручную; это не публикация в центральном каталоге Kimi. Гейт `test:kimi-marketplace` поднимает `kimi web` на свободном порту с временным `KIMI_CODE_HOME` и токеном только внутри него; модель не настраивается и не расходуется.

## Ограничения

- Схема `kimi.plugin.json` и marketplace версии `2` зафиксированы artifact-тестом; поведение конкретной сборки Kimi Code CLI/Desktop при подключении local source может отличаться — проверяйте на своей версии.
- Сервер стартует при каждой сессии в любом проекте; в проектах без opt-in он dormant и не создаёт файлов.
- Плагин — снимок дерева Bughunter. После изменений в core/пресетах пересоберите и обновите его.
- Центральной публикации нет. Поддерживается локальная установка через custom marketplace JSON с абсолютным путём к `plugin/dist/kimi/bughunter`; конкретный способ распространения должен задать publisher.
