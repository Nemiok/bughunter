# Нативные marketplace-установки Bughunter для Kimi, Qwen и Claude — дизайн

Дата: 2026-11-17.

## Контекст

Bughunter `v0.1.0` поставляется как Qwen-плагин с собственным server/core, пресетами web и node,
семью скиллами и шестью агентами. `plugin/install.mjs` вызывает Qwen CLI, а `plugin/build.mjs`
создаёт `.claude-plugin/plugin.json` с Qwen-специфичными путями и prompt-рендерингом. Доменное ядро
и пресеты уже отделены друг от друга, но host-адаптер пока один.

Цель нового этапа — один исходный Bughunter упаковывать в нативные плагины для Kimi, Qwen и Claude.
Пользователь добавляет штатный custom marketplace один раз, после чего установка и обновления идут
через обычный plugin UI/CLI хоста. Параллельно готовятся пакеты для отправки во встроенные каталоги.
Встроенный listing не считается выполненным до фактического принятия платформой.

Выбранный подход — общий server payload и нативные host-адаптеры. Agent Plugins v1 не может заменить
полный пакет: опубликованный стандарт переносит skills и MCP, а Qwen в этом формате игнорирует
agents/commands. Перенос модельной оркестрации внутрь MCP-сервера не рассматривается.

## Принятые решения

1. Первый кросс-хостный релиз охватывает экосистемы Kimi, Qwen и Claude, а не все AI-клиенты сразу.
2. Полный доказательный workflow и MCP-only являются разными уровнями поддержки и разными записями
   каталога: `bughunter` и `bughunter-mcp`.
3. Ни один хост не получает статус полной поддержки только потому, что манифест валиден или MCP
   подключился. Нужен живой модельный гейт на этом хосте/surface.
4. До принятия во встроенный каталог используется нативный custom marketplace. Прямая установка zip
   остаётся запасным каналом, но не выдаётся за marketplace.
5. Существующая локальная Qwen-установка и её пути сохраняются. Новые хосты не пишут в `.qwen/`.
6. Push, публикация, официальные заявки и новые модельные прогоны требуют отдельного явного
   разрешения и не являются побочным эффектом сборки.

## Цель и критерий завершения

Релизная команда из одного source commit создаёт валидируемые нативные артефакты и support matrix.
Для каждого заявленного full-хоста пользователь может установить `bughunter` из custom marketplace,
выбрать пресет, настроить стенд и выполнить доказательный прогон без копирования исходников,
`npm install` внутри плагина или ручного `.mcp.json`.

Кросс-хостный релиз готов только когда:

- все обязательные автоматические гейты прошли для каждого выпускаемого артефакта;
- Qwen не получил регрессий относительно существующего полного плагина;
- Kimi CLI/Desktop и Claude Code CLI/Desktop прошли собственные full model gates;
- каждая MCP-only публикация имеет собственный install/MCP/safety gate и честное описание ограничений;
- support matrix совпадает с фактически выполненными проверками;
- артефакты содержат одинаковые version и source commit, а их checksums опубликованы в release output;
- установка и обновление не перезаписывают config, profiles, runs и auth.

Фактическая публикация во встроенные каталоги — отдельный внешний процесс, а не критерий готовности
локального кода. Отсутствие аккаунта или модерации не должно маскироваться изменением статуса на
«опубликовано».

## Архитектура

### Общий payload

`.qwen/bughunter/core` и `.qwen/bughunter/presets/{web,node}` остаются доменным и методическим
источником для всех хостов. Сборка переиспользует один server payload с production-зависимостями.
В core и пресетах не появляются `if kimi`, `if claude`, `if qwen`, host-specific paths или импорты из
host-адаптеров.

Текущее переписывание `@bughunter/core` в относительный путь для portable Node-запуска сохраняется.
`plugin/dist/` и release output остаются генерируемыми и не редактируются вручную.

### Host adapter

Для каждого хоста создаётся небольшой модуль с одной ответственностью — описать интеграцию хоста.
Адаптер содержит:

- стабильный `hostId`: `qwen`, `kimi` или `claude`;
- renderer манифеста и marketplace;
- placeholder plugin root для MCP args;
- относительные пути opt-in и state;
- renderer entry-скилла, карт пресетов и agent frontmatter;
- имена `Agent`, `Skill`, файловых tools и namespaced agents для конкретного хоста;
- штатные команды validate/list/reload для установочного теста;
- декларацию поддерживаемых surfaces и capability level.

Адаптеры не содержат правил поиска багов, воспроизведения, триажа или red-вердиктов. Эти правила
остаются в core/presets и общем prompt source. Изменение доменного метода не требует трёх независимых
редактирований prompt-текста.

Новый общий launcher получает host descriptor при сборке, вычисляет opt-in/state через descriptor и
запускает выбранный пресет. `BUGHUNTER_STATE_DIR` сохраняется как явный override для изолированных
тестов. `BUGHUNTER_PRESET` сохраняется для совместимости и имеет приоритет над opt-in.

### Нативные пути

- Qwen: существующие `.qwen/bughunter.json` и `.qwen/bughunter/state/<preset>/`.
- Kimi: `.kimi-code/bughunter.json` и `.kimi-code/bughunter/state/<preset>/`.
- Claude: `.claude/bughunter.json` и `.claude/bughunter/state/<preset>/`.

State не переносится автоматически между хостами. Один проект по-прежнему использует один пресет в
одном host state. Auth и runs не записываются в plugin cache: обновление заменяет исполняемый пакет,
а не пользовательское состояние.

### Prompt rendering

Канонический entry workflow остаётся общим. Renderer подставляет только явно объявленные tokens:
entry invocation, preset card, explorer/reviewer/writer, paths и host-specific setup/reload.
Дополнительные различия допускаются через capability descriptor, а не через разрозненные правки
копий. Тесты проверяют, что все placeholders раскрыты и все ссылки указывают на компоненты пакета.

Для Claude учитываются фактические MCP tool names `mcp__plugin_<plugin>_<server>__<tool>` вместо
Qwen `mcp__bughunter__*`. Для Kimi верифицировано на 2.5.3: плагинный MCP сервер песочится каталогом
плагина (`cwd` = plugin root, переменные в `args` не раскрываются — путь к скрипту относительный,
`${KIMI_PLUGIN_ROOT}` существует только как env), клиент присылает пустые `initialize` capabilities,
поэтому рабочий каталог сессии доставляется нативным `SessionStart`-хуком (пишет cwd последней
стартовавшей сессии под `KIMI_CODE_HOME`), а инструменты в сессии именуются
`mcp__plugin-bughunter_bughunter__*` — не `mcp__bughunter__*`. Новая сессия сама по себе набор
инструментов не обновляет: обязателен `/reload` или рестарт MCP-сервера. Для Kimi используются
`kimi.plugin.json` и нативный plugin namespace. Для Claude и текущего Qwen-плагина используется
`${CLAUDE_PLUGIN_ROOT}`; это не объявляется универсальным стандартом для остальных хостов.

## Два уровня поддержки

### `bughunter`: полный пакет

Пакет включает MCP, семь скиллов, шесть агентов, server payload и authoring materials. Полный уровень
означает работающий цикл start/explore/reproduce/review/export/verify/finish с нативными субагентами,
воспроизведёнными багами и независимо проверенными красными тестами.

Целевая матрица первого релиза:

| Surface | Пакет | Целевой уровень | Условие публичного статуса `full` |
| --- | --- | --- | --- |
| Qwen Code CLI `1.0.0-preview.1` | Qwen native plugin | full | После рефакторинга прошли автоматическая линия и новый target model regression |
| Kimi Code CLI | `kimi.plugin.json` | experimental → full | Успешные target и resume model gates в CLI |
| Kimi Code Desktop | тот же Kimi source, Desktop-targeted артефакт/entry | experimental → full | Успешный target model gate в реальном Desktop UI и install/update gate |
| Claude Code CLI | `.claude-plugin/plugin.json` | experimental → full | Успешные target и resume model gates в CLI |
| Claude Code Desktop, local Code session | Claude native plugin | experimental → full | Успешный target model gate в реальном Desktop UI и install/update gate |

Версии Kimi и Claude фиксируются при implementation planning по фактически установленным клиентам;
support matrix содержит точные проверенные версии, а не неограниченное `latest`.

### `bughunter-mcp`: ограниченный пакет

MCP-only пакет содержит server payload, явную инструкцию по setup и минимальный skill/readme, если
surface их поддерживает. Он не содержит entry workflow, который обещает автоматическую оркестрацию,
и не заявляет reviewer/test-writer субагентов.

MCP-only означает только доступность инструментов и серверных защит. Пользователь/модель может
выполнять отдельные вызовы, но полный доказательный прогон не сертифицируется этим уровнем. Название,
описание каталога и отчёт поддержки обязаны прямо содержать `MCP-only; full workflow not certified`.

Первый дополнительный portable артефакт — Agent Plugins v1 для Qwen MCP-only, если он проходит
install/MCP/safety gate. Он выпускается как `bughunter-mcp` через поддерживаемые Qwen extension
sources; спецификация сама по себе не даёт marketplace listing.

Для Claude Cowork MCP-only артефакт рассматривается только после проверки локального stdio MCP в
реальном Cowork и поддержки выбранных компонентов. Обычный Claude chat и claude.ai не получают
локальный Bughunter MCP. Для MCPB/собственного Desktop runtime не обещается автоматическая
самодостаточность: такой артефакт выпускается только после отдельной проверки.

Независимо от дальнейшего расширения матрицы, full-пакет никогда незаметно не заменяется MCP-only.

## Marketplace и release-артефакты

Одна release-команда принимает version и формирует из одного source commit:

- `qwen/bughunter` и Qwen-compatible marketplace;
- `kimi/bughunter` с `kimi.plugin.json` и Kimi custom marketplace JSON;
- `claude/bughunter` и `.claude-plugin/marketplace.json`;
- включённые в данный релиз `bughunter-mcp` артефакты;
- `support-matrix.json` с host, surface, client version, level, artifact, gate evidence и status;
- человекочитаемый install/compatibility document;
- SHA256 для каждого zip и список компонентов с фактическими tool/skill/agent counts;
- license и third-party notices, необходимые bundled production dependencies.

Каждый marketplace генерируется как отдельный publishable source. Относительные plugin sources
используются только когда marketplace репозиторий действительно содержит plugin payload. Для hosted
JSON используются абсолютные HTTPS archive/git sources; локальные пути не попадают в публичный release.

Version обязательна и увеличивается для каждого release. Manifest и marketplace entry не содержат
расходящихся versions. Release output содержит source commit, чтобы provenance не зависел от памяти
оператора. Существующие `v0.1.0` zip, SHA и marketplace не перезаписываются: новая сборка получает
новую версию и новые checksums.

Официальные заявки:

- Kimi Curated требует партнёрского/платформенного принятия; custom marketplace JSON — fallback.
- Qwen Agent Plugins v1 не предоставляет marketplace integration; используется существующий нативный
  Qwen plugin/marketplace канал, а не выдуманный центральный реестр.
- Claude custom marketplace работает без submission form; Anthropic directory требует отдельной
  отправки, платного аккаунта и review. Официальный `claude-plugins-official` не считается открытым
  местом назначения для этой заявки.

## Пользовательский поток

### Установка

1. Пользователь один раз добавляет custom marketplace через нативный UI/CLI хоста.
2. В каталоге выбирает `bughunter` для certified full surface или отдельный `bughunter-mcp`.
3. Устанавливает пакет. Сервер и production dependencies уже включены; исходники Bughunter, ручной
   `.mcp.json`, `npm install` и build не требуются.
4. Пользователь открывает проект и вызывает нативный entry-скилл `bughunter`.

Node.js >=22.18 и Git остаются prerequisites. Web дополнительно требует установленный Google Chrome.
Это developer tool: первый релиз документирует зависимости и preflight, но не устанавливает системные
программы автоматически. Отсутствие зависимости не изображается как успешная готовность.

### Dormant и setup

Marketplace-установка не запускает `plugin/install.mjs`, поэтому создание opt-in переносится в явный
first-run flow.

Без opt-in и без явного `BUGHUNTER_PRESET` MCP-сервер подключается в dormant-режиме и отдаёт ровно
один host-level инструмент `bh_setup`. Он не открывает браузер, не создаёт run, не читает routes и не
отдаёт рабочие preset tools. В обычном marketplace flow до вызова setup состояние проекта не создаётся.

Entry-скилл доступен из plugin package независимо от MCP tools. Если opt-in отсутствует, он спрашивает
у пользователя `web` или `node` через нативный interaction mechanism и только после явного выбора
вызывает `bh_setup`. Setup:

- валидирует preset;
- атомарно создаёт host-specific opt-in и шаблон `state/<preset>/config.json`, не перезаписывая
  существующие файлы;
- возвращает `CONFIG_CREATED` и абсолютный путь к созданному config;
- сообщает host-specific шаг обновления toolset: для Qwen — `/plugins reload` или новая сессия;
  для Kimi — только `/reload`/рестарт MCP-сервера (новая сессия без reload продолжает видеть
  прежний набор — верифицировано на 2.5.3, см. ниже).

Явный `BUGHUNTER_PRESET` остаётся operator/test override и намеренно обходит opt-in, как в текущем
launcher; это не скрытый путь, который marketplace или entry-скилл выставляют сами.

После reload launcher видит preset и подключает обычные 19 web или 16 node tools; dormant `bh_setup`
не добавляется к этим наборам. Пользователь заполняет config и повторяет entry-команду. Этот reload —
сознательно принятая граница первой версии; динамическая активация пресета без reload не входит в
объём.

На Kimi 2.5.3 reload не сводится к новой сессии: хост держит MCP-подключение на рабочую область и
переиспользует его между сессиями, поэтому после setup или смены пресета/проекта нужен `/reload`
(или рестарт MCP-сервера). Рабочий каталог сессии серверу не передаётся ни spawn-окружением
(`cwd` = plugin root), ни MCP `initialize` (capabilities пустые); проект определяется
`SessionStart`-хуком плагина, который атомарно записывает cwd последней стартовавшей сессии
(только абсолютный путь) под `KIMI_CODE_HOME`, а лаунчер читает эту запись при старте. Это
осознанно принятое ограничение хоста: при нескольких открытых проектах действует правило последней
сессии, и без `/reload` уже запущенный сервер сохраняет прежний набор инструментов.

Существующий `plugin/install.mjs --preset ...` продолжает создавать Qwen opt-in сразу. Его путь не
требует дополнительного setup-вопроса. Ручная репозиторная установка и plugin-установка по-прежнему
не смешиваются.

### Конфигурация и auth

Схемы config не дублируются по хостам. Пресет создаёт и валидирует один и тот же config; адаптер
определяет только его расположение. Auth-flow web сохраняет storage state внутри выбранного host
state и никогда в plugin cache. Auth secrets, runs и generated artifacts не включаются в marketplace.

После настройки пользователь начинает с `/… target <route>` на full-хосте. MCP-only пакет не показывает
такой full workflow как поддерживаемый. Resume использует state того же хоста и той же схемы;
кросс-хостный resume не обещается.

### Обновление и удаление

Обновление идёт нативным plugin update/marketplace refresh. Оно никогда не перезаписывает opt-in,
config, profiles, known/suppressions, runs или auth. Повторный install/upgrade test запускается с
предварительно записанными sentinel-файлами и доказывает их сохранность.

Удаление плагина следует правилам хоста. Если хост удаляет собственный plugin data, это относится к
cache package, а не к project state. Документация прямо говорит, какие project files остаются и как
удалить их осознанно. Никакого автоматического удаления state при uninstall не добавляется.

## Ошибки и безопасность

- Отсутствие Node/Git/Chrome останавливает preflight с названием зависимости и проверяемой командой.
- Неподдерживаемая surface отсутствует в full marketplace variant либо явно обозначена unsupported;
  молчаливого fallback нет.
- Конфликт ручного `.mcp.json` или второго Bughunter server обнаруживается setup/preflight и требует
  оставить одну установку.
- Повреждённый opt-in/config не перезаписывается. Возвращается путь и конкретная ошибка разбора или
  схемы; существующее поведение строгой config-валидации сохраняется.
- Несовместимая версия хоста фиксируется в support matrix. Если клиент позволяет engines/version
  constraint, она объявляется нативно; иначе preflight выдаёт явное предупреждение до run.
- `BUGHUNTER_STATE_DIR` разрешён как test/operator override, но auth/runs всегда игнорируются Git в
  активном state. Setup не печатает auth contents или credentials.
- Существующие origin, forbidden actions, readOnly, lease, replay budgets и test verdict deadlines не
  ослабляются ради MCP-only или нового хоста.
- MCP stdout остаётся зарезервирован для протокола; diagnostics идут в stderr. Launcher не выполняется
  как обычный текстовый CLI.
- Сбой одного marketplace build/validation блокирует выпуск этого хоста, но не изменяет provenance и
  статусы остальных. Релизная сводка перечисляет blocked хосты вместо общего ложного PASS.

## Проверка

### Общие автоматические гейты

До host gates заново проходят существующие core/web/node tests и typechecks, CLI-template tests,
`node plugin/build.mjs` и install tests. Если общий launcher меняет Qwen behavior, portable и prompt
тесты обновляются только под новый контракт без ослабления lifecycle/assertions.

Для каждого full native package:

1. Нативный strict manifest/marketplace validation.
2. Сканирование artifact на unresolved placeholders, чужие host paths и отсутствующие компоненты.
3. Установка из сформированного local custom marketplace в изолированный config дома хоста.
4. Проверка enabled/loaded status, реального stdio MCP handshake и точных tool/skill/agent counts.
5. Dormant: только `bh_setup`, state не создан. Setup: создан правильный opt-in/config; после reload
   доступны 19 web или 16 node tools, без второго setup в активном наборе.
6. Отдельные web и node initialization checks; invalid preset/config дают явную ошибку.
7. Update/reinstall с sentinel config/profiles/runs/auth доказывает сохранность state.
8. Проверка entry invocation и фактического пула инструментов главного агента и каждого custom agent.

Для каждого MCP-only package выполняются пункты 1–6 в применимой части и server safety checks, но
нет заявки full model gate. Support matrix записывает `mcp-only`, а не `full`.

### Живые модельные гейты полного уровня

Все новые модельные прогоны запускаются только с отдельным разрешением пользователя, на локальных
фикстурах `127.0.0.1`, с записанным runId и логами. Для каждого нового full CLI-хоста:

- `target` на известной фикстуре: CLI/model run успешен, `run.status=finished`, все стадии done,
  очередь завершена, `Pending: None`;
- каждая explore task делегируется одному foreground native plugin agent; triage/export/verify не
  выполняются главным агентом в обход workflow;
- минимум один ожидаемый кандидат подтверждён и воспроизведён; ноль подтверждённых ложных;
- каждый экспортированный тест подтверждённого бага получает независимый red verdict, а выбранный
  регрессионный тест дополнительно запускается оператором отдельной командой;
- приложение не изменено, кроме разрешённых exported tests/config/state;
- отдельный resume gate после реального прерывания не повторяет завершённые candidates и завершает
  оставшуюся обработку.

Для Kimi Desktop и Claude Code Desktop выполняется отдельный интерактивный target gate в реальном UI:
trust/install/setup/reload, native agents, finished run и независимая red-проверка. Общий config с CLI
не заменяет Desktop evidence.

Если orchestration-характеристика хоста отличается (например, другой transcript format), gate adapter
проверяет фактические native события, не удаляя требование отсутствия параллельных explorers и
обхода серверной очереди. Исторические неуспешные Kimi MVP-прогоны не считаются доказательством нового
плагина.

### Support matrix как evidence

`support-matrix.json` генерируется из явного manifest поддержки и gate result files. Значения:

- `planned` — артефакт предусмотрен, проверки не выполнены;
- `experimental` — install/MCP gates прошли, full model gates ещё нет;
- `full` — все обязательные full gates прошли на указанной client version;
- `mcp-only` — заявлены и проверены только MCP capabilities;
- `blocked` — назван конкретный blocker;
- `unsupported` — surface не получает артефакт.

Нельзя вручную выставить `full` без ссылок на результаты target/resume и Desktop gate там, где он
требуется. README и каталог используют ту же матрицу, а не расходящиеся обещания.

## Документация

Активные документы после реализации различают:

- общую поддерживаемую архитектуру и нативные install paths;
- Qwen current path и новые Kimi/Claude paths;
- custom marketplace против official/curated listing;
- full против MCP-only;
- prerequisites против действительно bundled files;
- сохранение state и ограничения resume;
- проверенные client versions и evidence.

Исторические handoff/reports не переписываются. Старые release assets `v0.1.0` остаются снимком
старого source commit. Документация не содержит выдуманных owner/repo, HTTPS URLs или выполненных
публикаций; реальные значения появляются только при release configuration.

## Границы первого релиза

Не входят:

- Codex, Cursor, Windsurf и универсальная поддержка «большинства» клиентов как немедленный full scope;
- перенос модельной оркестрации внутрь MCP или облачный Bughunter service;
- remote MCP как замена локального доступа к project/browser;
- кросс-хостный state migration/resume;
- автоматическая установка Node, Git или Chrome;
- гарантированная установка без reload после первого выбора пресета;
- автоматический push, marketplace publication или official submission;
- обновление/подмена артефактов `v0.1.0`.

Расширение после первого релиза начинается с добавления descriptor и отдельных gates, а не изменения
core ради нового хоста. Agent Plugins v1 остаётся дополнительным portable MCP-only каналом; его
наличие не убирает нативные full-пакеты.

## Этапы реализации

1. Ввести host descriptor и вынести Qwen paths/rendering без изменения доменного поведения; прогнать
   существующую линию и Qwen regression.
2. Добавить dormant `bh_setup`, config-safe first-run flow и update preservation tests.
3. Добавить Kimi adapter, native package/custom marketplace, deterministic install gates, затем
   CLI/Desktop model gates.
4. Добавить Claude adapter с фактическими tool names и paths, deterministic install gates, затем
   CLI/Desktop model gates.
5. Добавить только те MCP-only artifacts, которые имеют конкретный проверяемый host/surface; не
   расширять список ради количества.
6. Сгенерировать release support matrix, docs, checksums и publication bundles. Публикацию выполнять
   отдельной командой/действием после разрешения.

Каждый этап имеет собственный тестовый контракт и не выдаёт следующий непроверенный хост за готовый.

## Источники совместимости

Проверка дизайна опирается на следующие первичные документы; фактические client versions и поведение
повторно проверяются во время реализации:

- Qwen Agent Plugins v1: <https://github.com/QwenLM/qwen-code/blob/main/docs/users/extension/agent-plugins.md>
- Agent Plugins specification: <https://github.com/agentplugins/agent-plugins-spec>
- Kimi CLI plugins: <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html>
- Kimi Desktop extensions: <https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html>
- Claude Code install: <https://code.claude.com/docs/en/plugins/install>
- Claude Code components: <https://code.claude.com/docs/en/plugins/components>
- Claude marketplace reference: <https://code.claude.com/docs/en/plugins/marketplace-reference>
- Claude publishing: <https://code.claude.com/docs/en/plugins/publish>
- Claude Desktop/web connectors: <https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors>

## Git-границы этого дизайна

Единственный commit на этапе дизайна содержит только этот spec. Существующий untracked
`docs/superpowers/plans/2026-11-17-docs-c1-c20.md` не добавляется. Этот spec не разрешает commit
реализации, push, публикацию или модельные прогоны; они требуют отдельного разрешения.
