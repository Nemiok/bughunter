# Bughunter как Qwen-плагин

Это README Qwen-артефакта: плагин ставит Bughunter одной командой в Qwen Code CLI, регистрирует
MCP-сервер, включает промпт-слой и создаёт opt-in-файл проекта. Копировать дерево в `.qwen/bughunter`
и писать `.mcp.json` вручную не нужно. Общая матрица нативной установки по хостам (Qwen, Kimi,
Claude) — в корневом [`README.md`](../../README.md); Kimi- и Claude-артефакты собираются из того же
дерева и имеют собственные README — [`hosts/kimi.README.md`](hosts/kimi.README.md) и
[`hosts/claude.README.md`](hosts/claude.README.md).

Проверено на Qwen Code CLI `1.0.0-preview.1`. Нужны Node.js ≥ 22.18 и Git в целевом проекте; для веб-пресета — установленный Google Chrome.

## Установка

Из корня целевого проекта:

```sh
node /путь/к/bughunter/plugin/install.mjs --preset web
```

Если исходники Bughunter лежат внутри проекта:

```sh
node plugin/install.mjs --preset web
```

Команда делает четыре вещи:

1. собирает `plugin/dist/bughunter` — самодостаточный сервер с core, обоими пресетами и production-зависимостями (≈30 МБ);
2. ставит плагин в user-scope (`qwen plugins install -s user`) и включает его;
3. пишет `.qwen/bughunter.json` с выбранным пресетом;
4. печатает, что осталось сделать.

После установки:

1. Разрешите инструменты в пользовательском или проектном `.qwen/settings.json`:

```json
{ "permissions": { "allow": ["mcp__bughunter__*"] } }
```

2. Перезапустите `qwen` (или выполните `/plugins reload`).
3. В корне проекта запустите `<entryInvocation>`. Это имя плагинного скилла; старый `/bughunter` относится к ручной установке и здесь не действует.
4. Первый запуск вернёт `CONFIG_CREATED` с путём к `config.json`; заполните его и запустите снова.

Проверка подключения: `qwen plugins list`; в сессии — `/mcp`. `qwen mcp list` показывает только
серверы из `.mcp.json` и plugin-серверы не перечисляет.

## Пресеты

Проект выбирает один пресет через `.qwen/bughunter.json`:

```json
{ "preset": "web" }
```

или

```json
{ "preset": "node" }
```

- `web` — маршруты и экраны, Playwright/Chrome, `baseUrl`, `allowedOrigins`, `routes`, `targetMap`; профиль необязателен.
- `node` — HTTP-API, эндпоинты и сценарии; `profile` обязателен, `scenarios` объявляют ожидания, `reset` возвращает стенд в исходное состояние.

Оба пресета входят в плагин, но сервер запускает только выбранный. Один проект — один пресет. Смена пресета: отредактируйте файл и перезапустите `qwen`.

## Где состояние

```text
.qwen/bughunter/state/<preset>/
  config.json
  profiles/
  runs/
  auth/
  preset.json
```

`state/<preset>/.gitignore` игнорирует `runs/` и `auth/`. `config.json`, `profiles/`, `preset.json`, `known-bugs.json` и `suppressions.json` можно версионировать.

Без `.qwen/bughunter.json` плагин находится в **dormant**-режиме: MCP-сервер подключается и отдаёт только `bh_setup`; состояние в проекте не создаётся до первого setup. Это защищает чужие проекты, где Bughunter не нужен.

## Авторизация веб-стенда

```sh
BUGHUNTER_STATE_DIR="$PWD/.qwen/bughunter/state/web" \
  node ~/.qwen/plugins/cache/local/bughunter/0.1.0/server/presets/web/src/auth.ts
```

Скрипт открывает headed Chrome по `baseUrl` из конфига, после входа сохраняет `state/web/auth/storage-state.json` — туда, откуда его читает сессия. Путь к кэшу плагина зависит от версии; его печатает `qwen plugins list --json` (`installPath`).

## Авторство нового пресета

В плагин входят авторские скиллы `bughunter:bughunter-preset-guide` и
`bughunter:bughunter-core-contract`, рабочий шаблон CLI-пресета и бриф. Порядок работы —
`<installPath>/AUTHORING.md`, шаблон — `<installPath>/template/cli-preset`, бриф —
`<installPath>/template/authoring-brief.md`; `installPath` печатает установщик или
`qwen plugins list --json`.

Один бриф — это одно задание агенту: он адаптирует шаблон под домен, пишет фикстуру и прогоняет
детерминированную приёмку. Это не one-shot на минуту: отчёт, порог засеянных дефектов, 0 ложных и
независимая перепроверка red-тестов обязательны.

## Обновление и удаление

```sh
node plugin/install.mjs --rebuild --preset web   # пересобрать и переустановить
qwen plugins disable bughunter@local             # выключить
qwen plugins uninstall bughunter@local           # удалить
```

Удаление плагина не удаляет `.qwen/bughunter.json` и `.qwen/bughunter/state/`; уберите их вручную, если состояние больше не нужно.

## Миграция с ручной установки

Плагин регистрирует MCP-сервер с именем `bughunter`. Если в проекте уже есть `.mcp.json` с такой записью, удалите её: два сервера с одним именем конфликтуют. Ручное дерево `.qwen/bughunter`, скиллы и агенты плагин не использует; держите одну установку.

Плагин хранит состояние в `.qwen/bughunter/state/<preset>/`, ручная установка — в `presets/<preset>/state/`. Прогоны ручной установки в плагине не видны. Если старые прогоны нужны, оставайтесь на ручной установке.

## Сборка и проверка

```sh
node plugin/build.mjs        # собрать и провалидировать плагин
node plugin/test-install.mjs # изолированный --config-dir: install/enable + dormant/web/node init
npm --prefix plugin run test:qwen-marketplace # нативный marketplace: add/install/update через qwen CLI
```

`test-install.mjs` не вызывает модель: он читает `system/init` и проверяет, что плагин поднял MCP-сервер, отдал 19 web- или 16 node-инструментов, семь скиллов и шесть агентов, а в dormant-режиме не создал состояние.

`test/qwen-marketplace-install.mjs` поднимает сборку как custom marketplace (`dist/qwen-marketplace` с `.claude-plugin/marketplace.json` и `plugins/bughunter/`), ставит плагин нативно через `qwen plugins marketplace add` + `qwen plugins install bughunter@bughunter-market`, проверяет dormant init (`mcp__bughunter__bh_setup`), затем обновляет marketplace и плагин (`qwen plugins marketplace update`, `qwen plugins update`) и проверяет, что config, `runs/` и `auth/` в проекте сохранились. Модель не вызывается; qwen init обрывается сразу после `system/init`.

`plugin/dist/` — генерируемый каталог, в Git не попадает.

## Release zip и self-hosted marketplace

Собранный zip должен содержать `.claude-plugin/plugin.json` в корне и устанавливается по HTTPS URL:

```sh
qwen plugins install https://host/bughunter-0.1.0.zip
```

`https://host/...` — пример места назначения, а не действующий публичный адрес. Локальный zip CLI не принимает.

Self-hosted marketplace публикуется как отдельный git-репозиторий с `.claude-plugin/marketplace.json` и `plugins/bughunter/`:

```sh
qwen plugins marketplace add owner/repo
qwen plugins install bughunter@bughunter-market
```

`owner/repo` заменяется на реально опубликованный репозиторий. Для локальной проверки marketplace добавляется абсолютным путём. Отсутствие опубликованного URL не выдавать за выполненную публикацию.

Custom marketplace в этой инструкции — self-hosted каталог, который оператор добавляет себе вручную (`qwen plugins marketplace add`). Это не официальная публикация в маркетплейсе Qwen: записи в центральном каталоге нет, и её наличие не предполагается.

## Ограничения

- Поддержка плагинных MCP-серверов и агентов проверена на Qwen Code CLI `1.0.0-preview.1`; на других версиях поведение может отличаться.
- Нативные установка и обновление (custom marketplace, install/update) проверены гейтами без модельных прогонов; модельный `target`-гейт после хост-рефактора не прогонялся, поэтому полный workflow здесь не заявлен — текущий статус по хостам публикует генерируемый `COMPATIBILITY.md` релиза.
- Сервер стартует при каждой сессии `qwen` в любом проекте; в проектах без opt-in он dormant и не создаёт файлов.
- Плагин — снимок дерева Bughunter. После изменений в core/пресетах пересоберите и переустановите его.
- Центральной или npm-публикации нет. Поддерживаются установка из исходника, HTTPS release zip и self-hosted marketplace; конкретный remote/URL должен задать publisher. Без license/notices и URL publisher'а публикация релиза остаётся заблокированной.
