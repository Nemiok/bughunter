# Bughunter как Qwen-плагин

Плагин ставит Bughunter одной командой: собирает сервер, регистрирует его в Qwen Code CLI, включает промпт-слой и создаёт opt-in-файл проекта. Копировать дерево в `.qwen/bughunter` и писать `.mcp.json` вручную не нужно.

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
3. В корне проекта запустите `/bughunter:bughunter`. Это имя плагинного скилла; старый `/bughunter` относится к ручной установке и здесь не действует.
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

Без `.qwen/bughunter.json` плагин находится в **dormant**-режиме: MCP-сервер подключается, но не отдаёт инструментов и не создаёт состояние в проекте. Это защищает чужие проекты, где Bughunter не нужен.

## Авторизация веб-стенда

```sh
BUGHUNTER_STATE_DIR="$PWD/.qwen/bughunter/state/web" \
  node ~/.qwen/plugins/cache/local/bughunter/0.1.0/server/presets/web/src/auth.ts
```

Скрипт открывает headed Chrome по `baseUrl` из конфига, после входа сохраняет `state/web/auth/storage-state.json` — туда, откуда его читает сессия. Путь к кэшу плагина зависит от версии; его печатает `qwen plugins list --json` (`installPath`).

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
```

`test-install.mjs` не вызывает модель: он читает `system/init` и проверяет, что плагин поднял MCP-сервер, отдал 19 web- или 16 node-инструментов, пять скиллов и шесть агентов, а в dormant-режиме не создал состояние.

`plugin/dist/` — генерируемый каталог, в Git не попадает.

## Ограничения

- Поддержка плагинных MCP-серверов и агентов проверена на Qwen Code CLI `1.0.0-preview.1`; на других версиях поведение может отличаться.
- Сервер стартует при каждой сессии `qwen` в любом проекте; в проектах без opt-in он dormant и не создаёт файлов.
- Плагин — снимок дерева Bughunter. После изменений в core/пресетах пересоберите и переустановите его.
- Публикации в npm или marketplace пока нет: распространяется каталог `plugin/` или собранный `plugin/dist/bughunter`.
