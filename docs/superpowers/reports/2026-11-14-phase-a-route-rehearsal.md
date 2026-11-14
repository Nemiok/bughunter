# Route-репетиция фазы A — отчёт

Дата прогона: **2026-11-14** (05:30:24 – 06:16:54 UTC). Определение — спецификация
`docs/superpowers/specs/2026-11-13-bughunter-core-and-presets-design.md` §6.11, задача 13 плана
`docs/superpowers/plans/2026-11-13-bughunter-core-preset-split.md`. В плане фаза A датирована
2026-11-13, фактический прогон состоялся на сутки позже; имя отчёта несёт фактическую дату.

Репетиция — единственное модельное доказательство, разрешённое после разреза: она проверяет, что
физическое разделение на `core` и `presets/web`, нейтральная лексика схемы состояния
(`target`/`sweep`/`targets`/`targetStages`) и переименование `bh_export_e2e → bh_export_test`
не сломали оркестрацию. Поведение веб-пресета при этом не менялось.

## Условия

| Параметр | Значение |
| --- | --- |
| Ветка / HEAD | `phase-a-core-split`, `765ffa8` |
| Фикстура | `.qwen/bughunter/fixtures/buggy-app` (демо на vite, `127.0.0.1:64954`) |
| Копия | `bughunter-gate/phase-a-rehearsal/project` — вне `.qwen/`, как требуют чувствительные пути CLI |
| Команда | `caffeinate -i qwen -p '/bughunter target /orders/new' --output-format stream-json --no-session-persistence --allowed-mcp-server-names bughunter` |
| Разрешения | точечный allow-list в `.qwen/settings.json` копии (`mcp__bughunter__*`, `Agent`, `Skill`, `Read`, `Grep`, `Glob`, `Edit`, `Write`); `--dangerously-skip-permissions` **не использовался** |
| Конфиг копии | новая схема: `tests.generated.dir = e2e/bughunter`, `targetMap`, `baseUrl`/`allowedOrigins` = порт копии, `routes` = 5 целей включая контрольную `/clean` |
| Длительность | 46 мин 30 с (`duration_ms 2787155`), бюджет ≤ 1 ч соблюдён |
| Действий пользователя | не потребовалось |

Перед прогоном копия проверена дёшево, без модели: stdio-рукопожатие точки входа
`presets/web/src/index.ts` вернуло `serverInfo: bughunter 0.1.0` и **19 инструментов**, включая
`bh_export_test`; `system/init` самого прогона показал тот же пул, статус MCP `connected`, три
проектных агента (`bh-explorer`, `bh-reviewer`, `bh-test-writer`) и шесть скиллов
(`bughunter`, `bughunter-core-contract`, `bughunter-preset-guide`, `bughunter-preset-card`,
`bughunter-oracles`, `bughunter-red-test`).

## Критерии PASS

| Критерий (§6.11) | Результат |
| --- | --- |
| CLI exit 0 | **PASS**: `QWEN_EXIT=0`, `result.subtype=success`, `is_error=false`, 23 turn'а |
| Run `finished` | **PASS**: run `20261114T053038.281Z-4c4e72df3973`, `scope: target`, `targets: ["/orders/new"]`, `status: finished`, стадии `explore/reproduce/triage/export` — `done`, `targetStages: {"/orders/new": "done"}`, очередь 3/3 `done`, `report.md` → `Pending: None` и `Unreproduced: None` |
| 0 батчей | **PASS**: 22 assistant-сообщения с инструментами, ни одного с более чем одним `tool_use` |
| Чередование `bh_explore_next` → один `Agent(bh-explorer)` | **PASS**: 4 вызова `bh_explore_next` (три задачи + финальный `done`) и ровно три `Agent(bh-explorer)`, по одному на задачу; порядок в JSONL — `Skill → bh_start_run → bh_explore_next → Agent → bh_explore_next → Agent → bh_explore_next → Agent → bh_explore_next` |
| ≥ 1 confirmed | **PASS**: 2 confirmed из 7 кандидатов |
| Красный спек, перепроверенный моим запуском | **PASS**: `npx playwright test e2e/bughunter --workers=1` в копии → **2 failed** (оба спека красные); `npx vitest run src/orders-api.test.ts src/orders.test.ts` → **2 failed / 1 passed** (проходит только предсуществующий тест) |

Дополнительно проверено: код приложения не изменён — `diff -rq` между `fixtures/buggy-app/src` и
`src` копии даёт ровно два отличия, оба тестовые: новый файл `src/orders-api.test.ts` и
`src/orders.test.ts`, в который добавлены четыре строки нового `it(...)`. Ни один исходник
приложения не правился (инвариант 4).

## Оркестрация по ролям

Всего 8 вызовов `Agent`, все foreground: 3 × `bh-explorer` (персоны «новичок», «нетерпеливый»,
«граничный ввод»), 3 × `bh-reviewer`, 2 × `bh-test-writer` — по одному на подтверждённого
кандидата. Главный агент самостоятельно вызывал только `Skill`, `bh_start_run`,
`bh_explore_next`, `bh_reproduce` (7 раз) и `bh_finish_run`; `bh_triage`, `bh_export_test`,
`bh_detect_tests` и `bh_verify_red` в его сообщениях не встречаются — они выполнены внутри
субагентов, как требует entry-скилл.

## Кандидаты

| Кандидат | Статус | Воспроизведение | Тесты |
| --- | --- | --- | --- |
| `151d10bf` Создание заказа с пустым Quantity → HTTP 500 без сообщения об ошибке | confirmed | reproduced, 3 попытки | e2e + unit (`src/orders-api.test.ts`) |
| `5203589f` Текст «NaN» в списке заказов после создания заказа | confirmed | reproduced, 3 попытки | e2e + unit (`src/orders.test.ts`) |
| `03084b42`, `0bffb574`, `5b0d0867`, `c17df3fc` | duplicate | reproduced | — |
| `f93eebe4` Сохранённое имя профиля не сохраняется после перезагрузки | rejected | reproduced | — |

Подтверждённых ложных срабатываний нет: отклонён один кандидат, и он касается цели за пределами
области прогона (`/profile`), куда исследователь зашёл по ссылке формы.

Оба подтверждённых бага — засеянные баги 2 и 4 демо-фикстуры. Баг 3 (дубль заказа при двойном
клике) и в этот раз не подтверждён: кандидат `0bffb574` с таким заголовком создан персоной
«нетерпеливый», но классифицирован как дубликат бага 4 по сигнатуре. Это совпадает с историей
полного гейта и остаётся известной границей класса «кратность эффекта».

## Наблюдения

1. **Предупреждения конвертера схем в stderr.** `unknown format "starts_with" ignored in schema at
   path "#/properties/target"` (четыре раза) и `strict mode: use allowUnionTypes to allow union type
   keyword at "#/properties/check/properties/expected"`. Оба — про то, как CLI превращает zod-схему
   в JSON Schema для модели: ограничение `startsWith('/')` и юнион `string | number` не доезжают до
   клиента. Сервер их по-прежнему энфорсит, поэтому на поведение прогона они не повлияли (ни одного
   отказа по схеме в JSONL нет). Кандидат на небольшую правку фазы B: заменить `startsWith` на
   описание в `describe()` и разрешить юнион, чтобы модель видела настоящие ограничения.
2. **Дубликаты — цена одной цели на три персоны.** 4 из 7 кандидатов оказались дублями: на узкой
   области три исследователя независимо приходят к одним и тем же двум симптомам. Дедупликация по
   сигнатуре отработала штатно, но reviewer потратил на них три вызова. Для `target`-прогонов это
   ожидаемая плата за точность; на `full` доля была ниже (2 из 9 в финальном гейте).
3. **Темп.** 46.5 минут на одну цель: ~5 минут на сессию исследователя, ~20 минут на
   воспроизведение семи кандидатов (каждый — по три попытки), остальное — review и запись тестов.
   Прогноз «65–85 минут», сделанный по середине прогона, не оправдался в пессимистичную сторону:
   reviewer и test-writer отработали быстрее, чем в полном гейте.
4. **Новая лексика в отчёте.** `report.md` печатает `- Scope: target` и `- Target:` вместо прежних
   `route`/`Route:`, созданные тесты — строчными именами пресета (`e2e:`, `unit:`). Совпадает с
   задачей 9 и не потребовало правок промптов по ходу прогона.

## Отклонения от брифа задачи 13

- **Команда запуска.** Бриф и спецификация §6.11 называют область `route /orders/new`; задача 9
  переименовала её в `target`, и strict-схема `bh_start_run` прежний литерал отклоняет. Запуск выполнен
  как `/bughunter target /orders/new`. Основание: спецификация §6.10 (однократный разрыв схемы без
  миграции) и ruling задачи 9.
- **Установка зависимостей в копии.** Бриф предлагал один `npm ci` в `presets/web`; фактически `npm ci`
  выполняется в корне workspaces (`.qwen/bughunter`) — иначе не появляется симлинк `@bughunter/core`.
  Основание: ruling задачи 1 о lockfile в корне workspaces.
- **Имя файла отчёта.** Бриф называл `2026-11-13-phase-a-route-rehearsal.md`; отчёт сохранён с
  фактической датой прогона, как остальные отчёты в `docs/superpowers/reports/`.
- **Счётчики автоматической линии.** Бриф ожидал `# pass 253` у пресета; фактически 254 pass / 0 fail /
  1 skipped (255) — добавлен тест карты пресета из задачи 11. Core — 45 тестов.

## Доказательства и очистка

Сохранено в `.qwen/bughunter/presets/web/state/runs/phase-a-rehearsal/` (каталог gitignored):
`rehearsal.stdout.jsonl` (200 КБ, 90 строк), `rehearsal.stderr.log`, `start.txt`/`exit.txt`,
`demo.log`, `port`, `run.json`, `report.md`, семь файлов кандидатов, два экспортированных спека и
добавленный unit-тест. Скрипт разбора JSONL — `.superpowers/sdd/2026-11-13-bughunter-core-preset-split/analyze.mjs`,
скрипт сборки копии — там же `rehearsal.sh`.

Не сохранено: артефакты сессий (`trace.zip`, `screenshot.png`, `video.webm`, 58 МБ) и само дерево
копии (221 МБ вместе с `node_modules`) — удалены после фиксации, как требует бриф. Демо-процесс
(PID 49324, порт 64954) остановлен тем же PID, который был поднят скриптом; порт свободен.

## Вывод

Разрез на `core` и `presets/web`, нейтральная лексика схемы состояния и переименование
`bh_export_test` оркестрацию не сломали: все шесть критериев §6.11 выполнены, батчинга нет,
красные тесты перепроверены независимым запуском. Это единственное модельное доказательство,
которое фаза A разрешала; полный гейт после разреза не запускался и не требуется спецификацией.
