# BUILD-REPORT — CLI-пресет bughunter

Дата сборки: 2026-11-16.
Корень копии: `/Users/nemiok/Desktop/projects/vault/bughunter-phase-b/bughunter-gate/guidelines-check/project`.
Пресет: `toolkit/presets/cli/`, пакет `@bughunter/cli`.
Цель: `cli-app/` — CLI-учёт заказов из snippet'а гайда, четыре засеянных бага и контрольный `list`.

Окружение измерения: `node v24.14.0`, `npm 11.9.0`. В описании окружения заявлен Node v26.3.0;
фактически измерен v24.14.0 (см. `PRESET-NOTES.md`, C17).

---

## 1. Что создано

### 1.1. Дерево файлов

```
cli-app/.gitignore                                      # игнорирует orders.json, .scratch/, test/bughunter/
cli-app/SEEDED.md                                       # реестр C1–C4, контрольного list и базовой линии
cli-app/package.json                                    # private ESM-пакет с маркером bughunter.target = "cli"
cli-app/src/cli.js                                      # целевое приложение из шага 6 гайда
toolkit/package.json                                    # workspaces: core, presets/web, presets/node, presets/cli
toolkit/presets/cli/.gitignore                          # state/preset.json, state/runs/, известные баги, suppressions, .test-*
toolkit/presets/cli/package.json                        # @bughunter/cli: test/typecheck/start, core, sdk, zod
toolkit/presets/cli/tsconfig.json                       # конфиг TypeScript, как в примерах поставки
toolkit/presets/cli/agents/bh-explorer.md               # исследователь: bh_open/state/act/report/close
toolkit/presets/cli/agents/bh-reviewer.md               # ревьюер: чтение прогона и один bh_triage
toolkit/presets/cli/agents/bh-test-writer.md            # автор теста: detect/export/verify, запрет правки приложения
toolkit/presets/cli/skills/preset-card/SKILL.md         # карта: пять инструментов, области, инвентарь, check, reset
toolkit/presets/cli/src/checks.ts                       # шесть видов check и CliCheck с pointer
toolkit/presets/cli/src/cli-host.ts                     # подсказка установки зависимостей при ERR_MODULE_NOT_FOUND
toolkit/presets/cli/src/config.ts                       # схема и шаблон CLI-конфига, восемь сценариев фикстуры
toolkit/presets/cli/src/detectors.ts                    # exit-code, stderr-stack, anomaly
toolkit/presets/cli/src/errors.ts                       # доменные коды и перевод нейтральных кодов core
toolkit/presets/cli/src/export-cli.ts                   # ExportTarget и генератор node:test-файла
toolkit/presets/cli/src/finding-kinds.ts                # виды находок, ярлык сценария, синтетический шаг
toolkit/presets/cli/src/index.ts                        # MCP-точка входа, ровно 16 инструментов
toolkit/presets/cli/src/inventory.ts                    # инвентарь команд и шаблоны argv
toolkit/presets/cli/src/paths.ts                        # stateDir по умолчанию и BUGHUNTER_STATE_DIR
toolkit/presets/cli/src/personas.ts                     # бухгалтер, ревизор, нетерпеливый
toolkit/presets/cli/src/preset.ts                       # сборка cliPreset из всех хуков
toolkit/presets/cli/src/profile.ts                      # ProfileSchema, загрузка профиля, appDirectory
toolkit/presets/cli/src/replay.ts                       # createCliReplay: reset, setup, повтор шагов, abort
toolkit/presets/cli/src/report-format.ts                # доменный рендер находок и кандидатов
toolkit/presets/cli/src/reset.ts                        # delete-db и RESET_UNSUPPORTED
toolkit/presets/cli/src/runs.ts                         # обёртки createRun, lease, finish, promote
toolkit/presets/cli/src/session.ts                      # spawn без shell, sandbox DB, setup, журнал, лимит шагов
toolkit/presets/cli/src/signature.ts                    # cliCheckSignature с pointer
toolkit/presets/cli/src/snapshot.ts                     # компактный снимок последних 10 запусков
toolkit/presets/cli/src/sweep-visit.ts                  # сброс, сценарии, сравнение с expect, находки
toolkit/presets/cli/src/test-report.ts                  # TAP → JSON, удаление NODE_TEST_CONTEXT
toolkit/presets/cli/src/test-runner.ts                  # detectTests, node:test-раннер, verifyCliRed
toolkit/presets/cli/src/types.ts                        # CliStep, CliCommand, CliScenario
toolkit/presets/cli/state/config.json                   # рабочий конфиг фикстуры: appDir, profile, reset, сценарии
toolkit/presets/cli/state/profiles/cli-app/index.ts     # профиль add/show/list с описаниями и sampleArgv
toolkit/presets/cli/test/harness.ts                     # временный state и копия конфига для тестов
toolkit/presets/cli/test/acceptance.bhtest.ts           # sweep → promote C1 → reproduce → triage → export → red
toolkit/presets/cli/test/checks-detectors.bhtest.ts     # все виды check и все детекторы
toolkit/presets/cli/test/config-store.bhtest.ts         # создание/валидация конфига и PRESET_CONFLICT
toolkit/presets/cli/test/export-verify.bhtest.ts        # экспорт подтверждённого кандидата и red
toolkit/presets/cli/test/preset.bhtest.ts               # 18 полей Preset и stdio-handshake на 16 инструментов
toolkit/presets/cli/test/prompts.bhtest.ts              # allowlist агентов, карта, фразы, персоны
toolkit/presets/cli/test/replay.bhtest.ts               # setup один раз, reset, abort, неполный шаг
toolkit/presets/cli/test/session.bhtest.ts              # изоляция БД, отсутствие shell, readOnly, лимит, reset
toolkit/presets/cli/test/sweep.bhtest.ts                # C1/C2/C4, чистая list, курсор, запрет действий
toolkit/presets/cli/test/test-report.bhtest.ts          # pass / assertion fail / broken и мусорный отчёт
PRESET-NOTES.md                                         # журнал решений, противоречий и желаемых правок core
BUILD-REPORT.md                                         # этот отчёт
```

`.mcp.json` не создавался и не менялся: в копии он уже указывает на
`node toolkit/presets/cli/src/index.ts`.

### 1.2. Что чем является

- **Инвентарь** — профиль `state/profiles/cli-app/index.ts`: команды `add`, `show`, `list`.
- **Цель** — шаблон команды; конкретный argv идёт в `bh_act.argv`.
- **Действие** — один процесс без shell, с изолированной базой `DB_FILE`.
- **Детекторы** — неожиданный код выхода, стек в stderr/stdout, аномальные токены.
- **Checks** — `exitCode`, `stdoutContains`, `stdoutNotContains`, `stderrContains`,
  `stderrNotContains`, `stdoutOccurrences`.
- **Replay** — reset, setup, повтор argv, сопоставление сигнала или check.
- **Sweep** — все сценарии цели с reset перед каждым, находки в `runs/<runId>/findings`.
- **Экспорт** — `node:test` в `test/bughunter/<bugId>.test.ts` проекта приложения.
- **Агенты** — `bh-explorer`, `bh-reviewer`, `bh-test-writer` с точными allowlist.

---

## 2. Команды и вывод

### 2.1. Установка зависимостей

```
$ cd toolkit && npm install
up to date, audited 108 packages in 536ms

36 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

`@bughunter/core` резолвится workspace-симлинком, потому что `presets/cli` добавлен в
`workspaces` корневого `toolkit/package.json`.

### 2.2. Тесты пресета

```
$ npm test --workspace=@bughunter/cli
> test
> node --test --test-concurrency=1 test/*.bhtest.ts

✔ acceptance: sweep promotes C1 and exports a red project test (513.208708ms)
✔ every declared check kind has a violation rule and validates its shape (0.664917ms)
✔ checks judge only the last execution of the session (69.884083ms)
✔ a check on an empty session is not violated and the preload signature includes the pointer (13.763459ms)
✔ detector scan flags unexpected exit, stack, anomaly, timeout and signal (5.003125ms)
✔ the Detectors hook drains pending signals exactly once (39.106917ms)
✔ ensureCliConfig creates a schema-valid template exactly once (10.521917ms)
✔ a broken config is rejected with the field name, not patched silently (6.599417ms)
✔ a missing config is reported as CONFIG_NOT_FOUND (0.32575ms)
✔ one state directory refuses a second preset (0.851083ms)
✔ confirmed candidate exports a project test and verify_red reports it red (282.70875ms)
✔ the preset declares all eighteen core fields and the expected dictionaries (0.504875ms)
✔ the entry point answers initialize and lists exactly sixteen tools (137.264458ms)
✔ each agent declares its exact tool allowlist (2.127417ms)
✔ every agent returns a self-contained final result and never edits application code (1.859958ms)
✔ agents invoke the shared core skills (1.171833ms)
✔ the explorer knows the three CLI personas and the failure vocabulary (0.336667ms)
✔ the preset card lists exactly the five CLI interaction tools (0.304833ms)
✔ the card names the check kinds, the pointer rule and the reset contract (0.275083ms)
✔ replay executes setup exactly once (65.158042ms)
✔ replay resets, executes setup and each attempt sees only its own data (109.582958ms)
✔ replay matches a signal signature and reports incomplete steps as unmatched (45.866417ms)
✔ abort closes the active replay session and later replays still work (36.920209ms)
✔ appDirectory finds the fixture above the workspace cwd without leaving the project (0.409625ms)
✔ a command runs without a shell, in an isolated database, and setup is journaled (89.045333ms)
✔ two sessions never share the sandbox database (70.738833ms)
✔ an unknown command and a mutating command under readOnly are refused before spawn (14.864708ms)
✔ the session step limit stops execution and keeps the journal intact (39.0025ms)
✔ reset deletes only the session database (62.977458ms)
✔ a reset without a recipe is a domain error, not a silent no-op (13.781ms)
✔ sweep finds C1, C2 and C4 from declared scenarios and leaves the clean list alone (277.740875ms)
✔ sweep cursor continues after a limit and does not repeat a target (284.147959ms)
✔ sweep session refuses model actions and a run of another scope is rejected (19.381ms)
✔ the reporter distinguishes passing, assertion-failing and broken test files (277.436125ms)
✔ a malformed report is not mistaken for a clean pass (0.106666ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3405.191
```

### 2.3. Typecheck

```
$ npm run typecheck --workspace=@bughunter/cli
> typecheck
> tsc
```

Команда завершилась с кодом 0 и без диагностики.

### 2.4. Stdio-рукопожатие

Запуск: `node --input-type=module -e '<скрипт>'` из корня копии; скрипт спавнит
`node toolkit/presets/cli/src/index.ts`, отправляет `initialize`, затем
`notifications/initialized`, затем `tools/list`, и убивает процесс после ответа.
Скрипт лежит только в истории команд, в копию не записан.

```
{
  "serverInfo": {
    "name": "bughunter",
    "version": "0.1.0"
  },
  "count": 16,
  "tools": [
    "bh_act",
    "bh_close",
    "bh_detect_tests",
    "bh_explore_next",
    "bh_export_test",
    "bh_finish_run",
    "bh_open",
    "bh_promote_finding",
    "bh_report_candidate",
    "bh_reproduce",
    "bh_resume_run",
    "bh_start_run",
    "bh_state",
    "bh_sweep",
    "bh_triage",
    "bh_verify_red"
  ]
}
stderr: ""
```

Одиннадцать core-имён: `bh_start_run`, `bh_resume_run`, `bh_explore_next`, `bh_finish_run`,
`bh_report_candidate`, `bh_reproduce`, `bh_triage`, `bh_promote_finding`, `bh_export_test`,
`bh_detect_tests`, `bh_verify_red`.
Пять пресетных: `bh_open`, `bh_state`, `bh_act`, `bh_sweep`, `bh_close`.

### 2.5. Базовая линия фикстуры

Измерение: `spawnSync(process.execPath, ["src/cli.js", ...argv])` из `cli-app/`, у каждого
сценария свой `DB_FILE` во временном каталоге внутри `cli-app/`; после замера каталог удалён.
Сырые строки:

```
{"argv":"show никакого","exit":1,"stdout":"","stderrFirstLine":"file:///.../src/cli.js:18","hasStack":true}
{"argv":"add banana -5","exit":0,"stdout":"ok banana total=-500\n","stderrFirstLine":"","hasStack":false}
{"argv":"add apple 3","exit":0,"stdout":"ok apple total=300\n","stderrFirstLine":"","hasStack":false}
{"argv":"add apple 3","exit":0,"stdout":"ok apple total=300\n","stderrFirstLine":"","hasStack":false}
{"argv":"list","exit":0,"stdout":"[{\"name\":\"apple\",\"qty\":3,\"total\":300},{\"name\":\"apple\",\"qty\":3,\"total\":300}]\n","stderrFirstLine":"","hasStack":false}
{"argv":"add x abc","exit":0,"stdout":"ok x total=NaN\n","stderrFirstLine":"","hasStack":false}
{"argv":"list","exit":0,"stdout":"[{\"name\":\"x\",\"qty\":null,\"total\":null}]\n","stderrFirstLine":"","hasStack":false}
{"argv":"list","exit":0,"stdout":"[]\n","stderrFirstLine":"","hasStack":false}
{"argv":"add apple 3","exit":0,"stdout":"ok apple total=300\n","stderrFirstLine":"","hasStack":false}
{"argv":"show apple","exit":0,"stdout":"300\n","stderrFirstLine":"","hasStack":false}
{"argv":"nope","exit":2,"stdout":"","stderrFirstLine":"unknown command: nope","hasStack":false}
```

Полный stderr C1 (сокращены только пути):

```
file:///.../cli-app/src/cli.js:18
  console.log(row.total);               // C1: неизвестное имя — необработанное исключение и стек наружу
                  ^

TypeError: Cannot read properties of undefined (reading 'total')
    at file:///.../cli-app/src/cli.js:18:19
    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)
    ...
Node.js v24.14.0
```

Все строки совпадают с `cli-app/SEEDED.md`.

### 2.6. Проверка чистоты копии

```
$ find . -maxdepth 4 \( -name '.test-*' -o -name '.baseline-*' -o -name '.handshake-*' \
    -o -name '.scratch' -o -name 'state' \) -not -path '*/node_modules/*'
./toolkit/presets/cli/state
./toolkit/presets/node/state
./toolkit/presets/web/state
```

В `toolkit/presets/cli/state` остались только `config.json` и `profiles/cli-app/index.ts`.
Каталогов `runs/`, файлов `preset.json`, `known-bugs.json`, `suppressions.json`, `.test-*`,
`.baseline-*`, `.handshake-*`, `.scratch` нет. Каталоги `state` у node/web — поставляемые
примеры, не наши артефакты.

---

## 3. Какие баги фикстуры найдены и чем доказан каждый

Терминология: «найден» ниже означает «получена находка/кандидат в запущенном коде», а не
«модель увидела глазами». Модельный прогон в этой работе не выполнялся (см. раздел 4).

| ID | Найден пресетом? | Чем доказан |
| --- | --- | --- |
| C1 | Да, sweep и end-to-end acceptance | `test/sweep.bhtest.ts:42-45` требует для `show <name>` находки `exit-code-unexpected` и `output-anomaly`; `test/acceptance.bhtest.ts:47-51` находит C1 (`show missing`, код не 2), промоутит его, `reproduceCandidate` даёт `2/2`, `triageCandidate` — `confirmed`, экспорт создаёт файл в `appDir`, `verifyCliRed` возвращает `red` с текстом «Неизвестный заказ». Базовая линия: код 1, пустой stdout, `TypeError` и стек `src/cli.js:18`. |
| C2 | Да, sweep | `test/sweep.bhtest.ts:36-40`: для `add <name> <qty>` два `exit-code-unexpected` (invalid `add x abc` и boundary `add banana -5`) и четыре `output-mismatch`. Базовая линия: `add banana -5` → exit 0, `ok banana total=-500`, в БД отрицательное количество. Ожидание сценария — код 2, отсутствие `total=-500`, слово «количество» в stderr. |
| C3 | Нет; оставлен модели | Sweep не содержит сценария «два add + list» и сбрасывает базу перед каждым сценарием, поэтому множественность строк не проверяется. Базовая линия доказывает баг фикстуры: два `add apple 3` дают две строки, `list` печатает массив из двух `apple`. `test/sweep.bhtest.ts:48` отдельно проверяет, что находки с двумя `add apple 3` нет, то есть C3 не выдаётся за найденный. Модельный прогон, который должен его найти, отложен харнессу. |
| C4 | Да, sweep | `test/sweep.bhtest.ts:40` требует `output-anomaly` с `NaN` для `add`; базовая линия: `add x abc` → exit 0, `ok x total=NaN`, `list` → `{"name":"x","qty":null,"total":null}`. Сценарий ожидает код 2, отсутствие `NaN` и слово «количество» в stderr. |
| — (`list`) | Контроль пройден | `test/sweep.bhtest.ts:47` требует пустой список находок для `list`; базовая линия: пустая база → `[]`, после `add` → корректный JSON, `list extra` → `[]`, код 0. |

Дополнительно `test/sweep.bhtest.ts` проверяет курсор: первый вызов с `limit: 1` проходит
только `add`, второй — `show`, третий — `list`, находки не повторяются. Это доказывает
возобновляемость обхода без модели.

---

## 4. Что осталось несделанным и почему

1. **Модельный прогон на фикстуре не выполнялся.** По заданию его запускает харнесс в свежей
   сессии после сдачи. В этой работе проверены детерминированный sweep, промоция C1,
   воспроизведение, triage, экспорт и red — но не поведение `bh-explorer`/`bh-reviewer`/
   `bh-test-writer` с реальной моделью. Поэтому C3 не подтверждён моделью, а требование
   «≥3 из 4 багов» (шаг 8.3 гайда) не проверено.
2. **Полная линия монорепо не запускалась.** Запускались только тесты `@bughunter/cli` и
   `typecheck` CLI. `npm test --workspaces` для core/web/node и route-репетиция web-пресета
   (шаг 8.5) не выполнялись, чтобы не тратить время на поставляемые домены и не менять их
   состояние. Это не доказательство их поломки, но и не доказательство их зелёности.
3. **Нет теста направления импортов.** Шаг 7 гайда требует отдельный тест-запрет
   `from '.*presets/` и `@bughunter/<other>`. В наборе его нет; соблюдение проверено вручную
   чтением импортов. Это незакрытое требование, а не «сделано иначе».
4. **Имена тестовых файлов отличаются от шага 7.** Вместо `test/cli-acceptance.bhtest.ts`
   создан `test/acceptance.bhtest.ts`; вместо `test/portable.bhtest.ts` handshake живёт в
   `test/preset.bhtest.ts`. Функционально покрытие есть, но строгая приёмка по именам его не
   найдёт.
5. **Не проверены установленная раскладка `.qwen/bughunter/` и другие способы запуска.**
   Handshake проверен запуском из корня копии по текущему `.mcp.json`. Запуск из `toolkit/`,
   из установленного `.qwen/bughunter/presets/cli` и с другим `BUGHUNTER_STATE_DIR` не
   прогонялся, хотя `appDirectory` и `defaultStateDir` это предусматривают.
6. **Не проверены Windows и Linux.** `shellArgument`, `killProcessTree` и `detached` имеют
   отдельные ветки; тесты шли только на macOS/darwin. Кроссплатформенное поведение не доказано.
7. **`exportTest` с временным `process.chdir` не проверен на конкурентность.** Гонка двух
   одновременных экспортов из одного процесса возможна; тесты её не воспроизводят.
8. **Не проверены `bh_resume_run`, `bh_finish_run` и `bh_detect_tests` через MCP-вызовы.**
   Их базовые функции покрыты частично (run-store, finish в core), но полный путь
   «модель вызывает инструмент → отчёт» в этой работе не прогонялся. Handshake доказывает
   только регистрацию инструментов.
9. **`bh_promote_finding` без `check` не отклоняется схемой.** Описание говорит «обязателен»,
   схема оставляет поле необязательным; такой кандидат дойдёт до генератора и получит
   `TEST_GENERATION_UNSUPPORTED`. Это записано в `PRESET-NOTES.md`, C11.
10. **C3 остаётся непокрытым детерминированным слоем.** Это осознанно: сценарий «два add +
    list» не объявлен, а сброс перед каждым сценарием не даёт проверить множественность в
    рамках одного визита. Если харнесс не запустит модель, C3 останется только базовой линией.
