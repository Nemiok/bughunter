# Bughunter

Инструмент, который ищет баги в работающем приложении **доказательно**: каждая заявленная находка
воспроизведена в чистой сессии, а каждый подтверждённый баг отдан вместе с красным регрессионным
тестом, вердикт которого получен независимым запуском. Не генератор отчётов «что может быть не так»:
если доказательства нет — утверждения нет.

Bughunter работает как MCP-сервер внутри агентского CLI (проверен Qwen Code CLI 1.0.0-preview) и
управляет моделью, а не наоборот: очередь задач, lease, лимиты, безопасность и вердикты принадлежат
коду, модель только выбирает, что исследовать дальше.

## Установка

Bughunter ставится нативным плагином в три хоста; артефакт на хост собирается из одного дерева
(`plugin/build.mjs`, описания хостов — `plugin/hosts/`):

| Host | Full entry | Project state |
| --- | --- | --- |
| Qwen | `/bughunter:bughunter` | `.qwen/bughunter/state/<preset>/` |
| Kimi | `/skill:bughunter:bughunter` | `.kimi-code/bughunter/state/<preset>/` |
| Claude | `/bughunter:bughunter` | `.claude/bughunter/state/<preset>/` |

- **Qwen Code CLI.** Автономная установка агентом по GitHub owner/repo, setup/validate и один
  явный перезапуск `qwen` в том же project/config — [`INSTALL.md`](INSTALL.md). На
  `1.0.0-preview.2` `/plugins reload` не обновляет MCP toolset, поэтому target запускается только
  в новой сессии после проверки 19 web или 16 node tools. Локальная установка из этого
  репозитория остаётся developer fallback: из корня целевого проекта
  `node /путь/к/bughunter/plugin/install.mjs --preset web`. Добавьте `mcp__bughunter__*` в
  `permissions.allow`, выполните setup/validate, затем перезапустите `qwen` и запустите
  `/bughunter:bughunter`. Плагин сам регистрирует MCP-сервер; `.mcp.json` и копирование дерева не
  нужны. Детали, пресеты и ограничения — [`plugin/README.md`](plugin/README.md).
- **Kimi Code CLI/Desktop.** Custom marketplace добавляется один раз (Settings → Plugins → добавить
  custom marketplace JSON), затем нативная установка плагина и обязательный `/reload`. Детали,
  префикс инструментов и мост SessionStart — [`plugin/hosts/kimi.README.md`](plugin/hosts/kimi.README.md).
- **Claude Code CLI/Desktop Code.** Custom marketplace добавляется один раз (`/plugin marketplace add`),
  затем `/plugin install bughunter@bughunter-market`. Детали —
  [`plugin/hosts/claude.README.md`](plugin/hosts/claude.README.md).

Три оговорки, чтобы таблица не читалась шире фактов:

1. Custom marketplace — self-hosted каталог, который оператор добавляет себе вручную. Записи в
   официальном/центральном каталоге маркетплейса нет, и её приёмка там не предполагается.
2. «Full entry» — точка входа скилла, а не уровень поддержки. Полный workflow сертифицируется
   только по evidence-гейтам (`install` + `public-install` + `activation` + `target` + `node-target`
   + `resume` на одном payload/client); артефакт `bughunter-mcp` — MCP-only поверхность и не означает полный workflow.
3. Текущий статус по хостам и поверхностям берётся из генерируемого `COMPATIBILITY.md` релиза
   (`plugin/release.mjs` собирает его из `plugin/evidence/`); README фиксирует устройство
   установки, а не дневную сводку.

Нативные установка и обновление проверены на Qwen Code CLI 1.0.0-preview.2, Kimi Code CLI 2.5.3
и Claude Code CLI 2.1.327. Модельные и публичные гейты привязаны к конкретному payload и клиентской
версии; уровень поддержки публикуется в `COMPATIBILITY.md` каждого релиза. `full` требует
`install` + `public-install` + `activation` + `target` + `node-target` + `resume` на одном payload/client; без любого
evidence поверхность остаётся experimental/planned/blocked. Qwen extensions и GigaCode остаются
planned до собственных runtime/model gates. Custom marketplace — не официальный листинг; SHA256
подтверждает целостность архива, но не является подписью. Ручная установка (Qwen, копирование дерева) —
[`.qwen/bughunter/README.md`](.qwen/bughunter/README.md) §3.

## Статус

Уровень поддержки и evidence конкретного релиза публикуются в его `COMPATIBILITY.md`. README не
дублирует дневную сводку; исторические отчёты остаются в `docs/superpowers/reports/`.

## Семь инвариантов

1. Детерминированное — в машине, модель только выбирает.
2. Ни одного утверждения без доказательства.
3. Точность важнее полноты: шумный отчёт — провал.
4. Инструмент не изменяет код приложения и ничего не коммитит.
5. Защиты энфорсит код, а не промпт.
6. Специфика живёт в пресете и профиле; core доменно-нейтрален.
7. Непроверенное не выдаётся за проверенное.

Развёрнуто, с примерами и следствиями — [`docs/concept/invariants.md`](docs/concept/invariants.md).

## Два домена

| | **core** | **preset** | **файлы пользователя** |
| --- | --- | --- | --- |
| Что это | метод и память | органы чувств и руки | экземпляр профиля и `config.json` |
| Владеет | жизненный цикл прогона, кандидаты, журнал, сигналы, находки, очередь и lease, протокол воспроизведения с его бюджетами и минимизацией шагов, дедлайны вердиктов тестов, отчёт, общие поля конфига | единица исследования, сессия и действия, снимок, детекторы, виды `check`, исполнение журнала в своём домене (`replay`), генератор теста, раннер, персоны, обход, сброс стенда, экспорт, доменные коды ошибок, рендер отчёта, агенты и карта инструментов | адрес стенда, разрешённые origin, область прогона, лимиты, экстракторы виджетов, тестовые данные |
| Где живёт | `.qwen/bughunter/core/` | `.qwen/bughunter/presets/<name>/` | `presets/<name>/state/` (как `.eslintrc` — файл пользователя) |
| Кто меняет | только задачи, меняющие метод | автор пресета | оператор |

Правило зависимости одно: **`preset → core`, никогда обратно**. Пресет — точка входа MCP-сервера,
core он подключает как библиотеку именем пакета `@bughunter/core`. Один проект = один пресет:
core-инструменты у всех пресетов именуются одинаково, поэтому два пресета в одном проекте дали бы
коллизию имён.

Пресет отвечает на пять вопросов, на которые core ответить не может: что такое единица исследования,
как увидеть цель и что с ней можно сделать, что считается симптомом, какое нарушение инварианта
проверяется детерминированно, как повторить журнал и какой тест из него собрать.

### Два пресета

| | **`@bughunter/web`** | **`@bughunter/node`** |
| --- | --- | --- |
| Домен | веб-приложение в браузере | HTTP-API локального сервиса |
| Единица исследования | экран — шаблон маршрута (`/orders/:id`) | эндпоинт — `«МЕТОД /шаблон»` (`GET /orders/:id`) |
| Действие | клик, ввод, навигация, проба viewport | один HTTP-запрос |
| Симптомы | консоль, pageerror, провалы сети, статусы, аномальный текст, error boundary | статус 4xx/5xx, стек и системные коды в теле, аномальные токены, таймаут |
| Оракулы (`check`) | `visibleText`, `notVisibleText`, `elementCount` | `status`, `jsonPath`, `headerContains` |
| Регрессионный тест | Playwright, вид `e2e` | Vitest, вид `api` |
| Инструментов MCP | 19 (11 core + 8 пресета) | 16 (11 core + 5 пресета) |
| Состояние | статус и evidence — в `COMPATIBILITY.md` релиза | статус и evidence — в `COMPATIBILITY.md` релиза |
| Операторский README | [`.qwen/bughunter/README.md`](.qwen/bughunter/README.md) | [`presets/node/README.md`](.qwen/bughunter/presets/node/README.md) |

Оба пресета подключают один `@bughunter/core` и не правят его: **ни один из коммитов node-пресета не
менял `core/`**, что проверяется diff'ом ветки, тестом направления импортов и тестом-запретом
доменной лексики в `core/src`. Пять коммитов, тронувших core за фазу B, — это два плановых переноса
метода (задачи 1–2), docs-тест и два дефекта оркестрации, найденные модельными гейтами; ни один не
сделан ради пресета. Учебный стенд node-пресета — `fixtures/node-api-app`: пять
эндпоинтов, шесть засеянных дефектов и контрольный `GET /health`, на котором находок быть не должно.

## Сделать свой пресет

**Пример копируй, core подключай.** Для нового домена копируется учебный `docs/concept/examples/cli-preset/preset`; `presets/web` и `presets/node` остаются поддерживаемыми браузерным и HTTP-образцами. Core подключается именем пакета. `Preset` содержит 16 интерфейсов (`TargetInventory`, `Session`, `Snapshot`, `Detectors`, `Checks`, `Replay`, `TestGenerator`, `ProfileSchema`, `TestRunner`, `Personas`, `FindingKinds`, `SweepVisit`, `Reset`, `ExportTarget`, `Errors`, `ReportFormat`) плюс обязательные `name` и `configSchema` — 18 полей всего. Критерий готовности пресета — **ноль правок core**.

- Пошагово для человека: [`docs/concept/preset-guide.md`](docs/concept/preset-guide.md)
- То же для модели внутри CLI: скилл `bughunter-preset-guide`
- Контракт и состав интерфейсов: скилл `bughunter-core-contract`
- Критерии отбора кандидатов и правила красных тестов: скиллы `bughunter-oracles`, `bughunter-red-test`

## Раскладка

```
bughunter/
├── README.md                     ← этот файл: концепция
├── docs/concept/                 ← инварианты и гайд прозой
├── docs/superpowers/             ← specs, plans, reports
└── .qwen/                        ← поставляемое дерево (точка входа CLI)
    ├── bughunter/
    │   ├── core/                 ← @bughunter/core: метод и память
    │   ├── presets/web/          ← @bughunter/web: веб-пресет и его state/
    │   ├── presets/node/         ← @bughunter/node: HTTP-пресет, его state/, агенты и карта
    │   └── fixtures/             ← buggy-app, bi-app, node-api-app, jest/vitest-проекты
    ├── agents/                   ← bh-explorer, bh-reviewer, bh-test-writer (пресет web)
    └── skills/                   ← bughunter (entry), core-contract, preset-guide,
                                    preset-card (web), oracles, red-test
```

`.mcp.json` в репозитории автора указывает на `presets/web/src/index.ts` напрямую, поэтому монорепо
остаётся живой установкой и не требует отдельной копии. Агенты и карта инструментов node-пресета
лежат в его дереве (`presets/node/agents/`, `presets/node/skills/`) и ставятся установщиком:
живая установка автора остаётся веб-пресетом — один проект, один пресет.

## Модельные гейты веб-пресета

### Финальный полный модельный гейт 2026-11-12 — PASS

Run `20261112T072651.852Z-4b2ba4ccfd96`, `/bughunter full` в одноразовой копии, 3 ч 59 мин.
4 из 5 засеянных багов подтверждены, 0 подтверждённых ложных срабатываний, 5 красных e2e-спеков
и 8 красных unit-проверок (перепроверено собственным запуском), 0 батчей в 69 сообщениях главного
агента, triage/export/verify — только внутри субагентов.

### Two-candidate resume гейт 2026-11-12 — PASS

Run `20261112T114339.688Z-1e5d834da4de`, SIGINT в PID `qwen` на стадии записи тестов, затем
`/bughunter resume <runId>`. Обработанное не переделано (7/7 кандидатов побайтово), оставшееся
доделано, 4 красных e2e.

### Интерактивный trust-гейт 2026-11-13 — PASS

Run `20261113T175433.164Z-07952730d99a`, `/bughunter target /profile` в интерактивной сессии без
headless-флагов: диалог folder trust и `/mcp` → approve выполнены пользователем, прогон завершился
`finished` за 1 ч 10 мин, 3 подтверждённых бага, 3 красных e2e-спека и 1 красный unit-тест
(перепроверено собственным запуском).

### Модельный smoke-прогон на BI-фикстуре 2026-11-13 — PASS (smoke)

Run `20261113T131557.204Z-68c505592f97`, `/bughunter target /dashboard/1` на `bi-app` с профилем
`bi`: 75.3 мин, 0 батчей в 86 сообщениях, 10 кандидатов → 3 confirmed / 3 rejected / 4 unreproduced,
0 подтверждённых ложных, 3 красных e2e и 2 красных unit-теста. Найдены два засеянных бага данных
(D1, D5) без оракула фазы 2. Отчёт: `docs/superpowers/reports/2026-11-12-bi-app-phase1-acceptance.md`.

### Модельный гейт после разреза: route-репетиция 2026-11-14 — PASS

Run `20261114T053038.281Z-4c4e72df3973`, `/bughunter target /orders/new` в одноразовой копии
`bughunter-gate/phase-a-rehearsal/project`, 46 мин 30 с, точечный allow-list вместо флага обхода.
Единственное модельное доказательство, разрешённое спецификацией после разреза (§6.11): exit 0,
`finished`, все стадии `done`, `Pending: None`, **0 батчей** в 22 сообщениях главного агента,
строгое чередование `bh_explore_next` → один `Agent(bh-explorer)`, 7 кандидатов → 2 confirmed /
4 duplicate / 1 rejected, 0 подтверждённых ложных. Красные тесты перепроверены независимым
запуском: `npx playwright test e2e/bughunter --workers=1` → **2 failed**, `npx vitest run` →
**2 failed / 1 passed**. Код приложения не изменён. Отчёт:
`docs/superpowers/reports/2026-11-14-phase-a-route-rehearsal.md`.

## Документация

- Операторский README веб-пресета (установка, конфиг, запуск, ограничения):
  [`.qwen/bughunter/README.md`](.qwen/bughunter/README.md)
- README хост-артефактов: Qwen — [`plugin/README.md`](plugin/README.md), Kimi —
  [`plugin/hosts/kimi.README.md`](plugin/hosts/kimi.README.md), Claude —
  [`plugin/hosts/claude.README.md`](plugin/hosts/claude.README.md); текущий статус по хостам —
  генерируемый `COMPATIBILITY.md` релиза
- История интеграции с Kimi Code CLI: git-тег `kimi-cli-mvp` (`git show kimi-cli-mvp`)
- Дизайн-документ разреза core/пресеты: `docs/superpowers/specs/2026-11-13-bughunter-core-and-presets-design.md`
