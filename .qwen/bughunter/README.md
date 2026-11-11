# Bughunter MVP

## 1. Сначала доверьте папке проекта

**Первый шаг — folder trust для Qwen Code CLI.** Откройте терминал в корне целевого Git-проекта, запустите `qwen`, доверьте папке (или IDE workspace trust при подключении) и при необходимости подтвердите project MCP из `.mcp.json` через `/mcp` → approve. Проектные skills/agents из `.qwen/` требуют trust для `allowedTools` и hooks.

Интерактивный диалог trust пока **не проверен вручную**; это остаётся обязательным ручным действием пользователя.

## 2. Честный статус проверки: MVP пока не готов

**Автоматические проверки проходят, но MVP нельзя считать полностью готовым.** Последний полный `npm test` (164 теста) и `npm run typecheck` проходят; переносимая копия также проверяет `npm ci`, настоящий MCP stdio handshake, все **16** инструментов (включая `bh_explore_next`), экспорт и red-вердикт без шага сборки.

**Task 17 (2026-11-11):** добавлена серверная очередь исследования и lease: параллельные исследователи и «чистые» отчёты без открытой сессии блокируются на уровне MCP, а entry skill ведёт цикл `bh_explore_next` → один foreground `bh-explorer`. Это структурный ответ на провал delegation gate из Task 15; **повторные full/resume gates на установленном Kimi CLI пока не выполнялись** — недельная квота провайдера исчерпана (`provider.api_error` в `state/runs/task17-full/kimi-full.stderr.log`).

Ручные и модельные gates до Task 17:

- **Full, попытка 2:** числовой gate прошёл — 4/5 засеянных багов подтверждены, 0 подтверждённых ложных срабатываний, для всех четырёх есть red e2e. Но обязательная оркестрация через custom agents **не пройдена**: в JSONL нет ни одного вызова custom `Agent`; triage/export/verification выполнялись главным агентом batch-вызовами.
- **Full, попытка 3:** **FAIL**. Одно сообщение модели содержало четыре одновременных `Agent(subagent_type="bh-explorer")` вместо последовательных вызовов. Тестовый процесс был остановлен; прогон остался незавершённым, без report/finish.
- **Финальный resume с двумя кандидатами** (один полностью обработанный и один необработанный) **не запускался и не проверен**. Более ранний one-candidate resume прошёл, но он предшествует финальному route guard и не заменяет этот gate.
- **Interactive workspace trust:** **PENDING / NOT VERIFIED**. Все модельные пробы были headless с `KIMI_CODE_TRUST_WORKSPACE=1`.

Сырые состояния, JSONL и отчёты сохранены в `.qwen/bughunter/state/runs/`. История Task 15/16 и детали Task 17 — в соответствующих SDD report. До успешного post-Task-17 full gate MVP остаётся **NOT READY**.

## 3. Установка в проект

Требования: Git, Node.js **≥ 22.18**, npm и установленный Google Chrome. Сервер выполняет TypeScript напрямую через Node type stripping; сборка не нужна.

1. Выполните интерактивный trust из раздела 1.
2. Скопируйте из дистрибутива в `.qwen/` целевого проекта:
   - `bughunter/` целиком;
   - `skills/bughunter/`, `skills/bughunter-oracles/`, `skills/bughunter-red-test/`;
   - `agents/bh-explorer.md`, `agents/bh-reviewer.md`, `agents/bh-test-writer.md`.
3. Добавьте в корень проекта **`.mcp.json`** (или объедините с существующим) с записью Bughunter:

```json
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": [".qwen/bughunter/server/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
```

По умолчанию stdio MCP стартует с `cwd` = корень проекта. `toolTimeoutMs` оставляет время на воспроизведение и запуск тестов. Первый запуск gated-сервера из репозитория может потребовать `qwen mcp approve bughunter`.

4. Установите только зависимости сервера из lockfile:

```sh
cd .qwen/bughunter/server
npm ci
```

5. Опционально скопируйте `.qwen/settings.json.example` в `.qwen/settings.json` проекта и добавьте allow для MCP Bughunter (или настройте permissions в user settings):

```json
{
  "permissions": {
    "allow": ["mcp__bughunter__*"]
  }
}
```

Ограничения origin, forbidden actions и read-only форм по-прежнему enforced сервером.

6. Отредактируйте `.qwen/bughunter/state/config.json` под целевой стенд. Поставляемый конфиг указывает на локальное демо `http://127.0.0.1:4173`. Если файла нет, первый `bh_start_run` создаст шаблон и вернёт `CONFIG_CREATED`; после заполнения конфига запустите команду заново.
7. Перезапустите `qwen` из корня проекта и проверьте `mcp__bughunter__*` (slash `/mcp` или tool list).

## 4. Chrome и авторизация

Bughunter использует **только Google Chrome** через Playwright `channel: "chrome"`; другие браузеры не поддерживаются. Установите Chrome штатным способом ОС. `playwright-core` не скачивает браузер в postinstall. Если Chrome не найден, установите его и повторите запуск; для воспроизведения артефактов video также должен быть доступен Playwright FFmpeg.

Если стенд требует входа:

```sh
cd .qwen/bughunter/server
npm run auth
```

Откроется обычный (headed) Chrome на `baseUrl`. Войдите вручную, вернитесь в терминал и нажмите Enter. Сессия сохраняется в `.qwen/bughunter/state/auth/storage-state.json` и автоматически используется новыми браузерными контекстами. Этот файл содержит секреты сессии, игнорируется Git и не должен передаваться или коммититься. Автоматические тесты не выполняли реальный интерактивный login.

## 5. Конфигурация `state/config.json`

JSON строго валидируется: неизвестные поля отклоняются. Все поля обязательны; `tests.unit.command` может быть `null`.

| Поле | Назначение |
| --- | --- |
| `baseUrl` | Абсолютный URL дев-стенда; начальная точка auth, навигации и экспортированных тестов. |
| `allowedOrigins` | Непустой список разрешённых абсолютных origin. Прямые, клиентские и popup-переходы за их пределы блокируются. |
| `routes` | Непустой список маршрутов, начинающихся с `/`; полный набор для `full` и допустимых `route`. |
| `routeMap` | Отображение glob-путей исходников на маршруты для `diff`, например `"src/pages/orders/**": ["/orders", "/orders/new"]`. |
| `baseBranch` | Базовая ветка для `git diff --name-only <baseBranch>...HEAD`. |
| `limits.stepsPerSession` | Положительный целый общий лимит действий, переходов и probes в одной сессии. |
| `limits.candidatesPerRun` | Положительное целое для лимита кандидатов на прогон. В текущем MVP поле валидируется, но отдельное enforcement этого лимита ещё не реализовано. |
| `safety.forbiddenActionText` | Строки запрещённого текста/имени элемента; сравнение нечувствительно к регистру до выполнения действия. |
| `safety.readOnly` | При `true` дополнительно блокирует explicit/implicit submit и связанные Enter/NumpadEnter. |
| `testDataPrefix` | Префикс автоматически генерируемых тестовых значений, например `bh_`. |
| `detectors.ignoreConsole` | Строки-исключения для console-сигналов. |
| `detectors.ignoreRequests` | Строки-исключения для network request/response-сигналов. |
| `detectors.anomalyTexts` | Токены аномального видимого текста, например `undefined`, `NaN`, `[object Object]`, `Invalid Date`. |
| `detectors.errorBoundarySelector` | Непустой CSS selector error boundary. |
| `tests.unit.command` | Явная команда project-local Jest/Vitest или `null` для автодетекции; verifier добавляет один файл и обязательные reporter-аргументы. |
| `tests.e2e.dir` | Каталог экспорта Playwright-тестов относительно ближайшего project root с `@playwright/test`. |

Для изолированных тестов сервер принимает `BUGHUNTER_STATE_DIR`; без него состояние всегда вычисляется от расположения `server/`, а не от текущего каталога.

## 6. Запуск и возобновление

Команды вводятся внутри интерактивной сессии `qwen` из корня целевого проекта (skill `/bughunter` или `/skill:bughunter`):

| Команда | Поведение |
| --- | --- |
| `/bughunter` или `/bughunter diff` | Scope по умолчанию. Сопоставляет изменённые относительно `baseBranch` файлы с `routeMap`; если совпадений нет, проверяет все `routes`. |
| `/bughunter full` | Последовательно проверяет все настроенные `routes` тремя персонами. |
| `/bughunter route /orders` | Проверяет один маршрут; он должен присутствовать в `routes`. |
| `/bughunter resume <runId>` | Продолжает существующий прогон по сохранённым route/stage/candidate state, не создавая новый run и не повторяя завершённую работу. |

`/bughunter` — shorthand для `/skill:bughunter`. Entry skill вызывается только вручную. Требуемый workflow: серверная очередь исследования выдаёт по одной паре маршрут–персона вместе с lease (`bh_explore_next`); главный агент делегирует каждую задачу одному foreground custom agent `bh-explorer`, затем воспроизводит каждого кандидата, вызывает отдельного reviewer и test-writer только для подтверждённых багов и завершает `bh_finish_run` без pending работы. `bh_open` без действующего lease отклоняется (`LEASE_REQUIRED`/`LEASE_UNKNOWN`/`LEASE_MISMATCH`), а одновременная сессия блокируется `EXPLORER_BUSY`, поэтому параллельные исследователи невозможны независимо от поведения модели. Реальное несоответствие этому workflow до введения очереди зафиксировано в разделе 2.

Bughunter не должен коммитить или менять код приложения. Headless-прогоны Qwen Code зависят от вашей установки (`qwen -p`, approvals, trust); автоматические gates на Qwen CLI **ещё не записаны** (исторические пробы — Kimi, см. tag `kimi-cli-mvp`).

## 7. Артефакты и состояние

Все рабочие данные находятся в `.qwen/bughunter/state/`:

- `config.json`, `known-bugs.json`, `suppressions.json` — конфигурация и общая signature-память; предназначены для совместного version control.
- `runs/<runId>/run.json` — scope, выбранные маршруты, статусы run/stage/route для resume.
- `runs/<runId>/candidates/<candidateId>.json` — кандидаты, reproduction/review и пути созданных тестов.
- `runs/<runId>/journals/<sessionId>.json` — семантические действия и сигналы.
- `runs/<runId>/artifacts/<candidateId>/` — `trace.zip`, `screenshot.png`, `video.webm`; у reproduction могут быть подкаталоги `replay-*`.
- `runs/<runId>/e2e/` — экспорт, если в проекте не найден `@playwright/test`; иначе файлы попадают в `tests.e2e.dir`.
- `runs/<runId>/report.md` — confirmed/rejected/duplicates/unreproduced/pending, минимальные шаги, артефакты и тесты.
- `auth/storage-state.json` — локальная auth-сессия.

`state/runs/` и `state/auth/` игнорируются локальным `.qwen/bughunter/.gitignore`. Их нельзя удалять при обычном обновлении: там могут быть незавершённые прогоны, доказательства gates и auth. Fixture Playwright output `.playwright-output/` также игнорируется.

## 8. Перенос и обновление без потери состояния

При переносе на другую машину/репозиторий копируйте `bughunter/`, три skill-каталога и три agent-файла, затем заново объедините `mcp.json` и выполните `npm ci`. Скопируйте существующий `state/` отдельно, если нужны общая память и resume; `auth/` лучше создать заново через `npm run auth`, а не переносить секреты.

**Для обновления сервера заменяйте только `.qwen/bughunter/server/`.** Не удаляйте и не перезаписывайте соседний `.qwen/bughunter/state/`. После замены выполните `cd .qwen/bughunter/server && npm ci`. Не копируйте новый `bughunter/` поверх установки целиком: это может затереть config, known/suppressions, runs и auth.

## 9. Изоляция от инструментов целевого проекта

Проверьте, что build/typecheck/lint/test целевого проекта не захватывают `.qwen/`. Тесты сервера имеют суффикс `.bhtest.ts`, но фикстуры содержат обычные `.test.*`, поэтому одного суффикса недостаточно.

- **TypeScript:** предпочтителен узкий `include`. В проверенном демо он ровно такой:

```json
{
  "include": ["src", "vite.config.ts"]
}
```

TypeScript `--listFiles` в переносимой копии не содержал файлов проекта из `.qwen/`. Если широкий `include` всё же захватывает служебные файлы, добавьте в `tsconfig.json` ровно `".qwen"` в `exclude` (и сохраните существующие исключения).

- **ESLint flat config:** если lint видит `.qwen`, добавьте ignore-объект:

```js
{ ignores: ['.qwen/**'] }
```

В демо ESLint не установлен, поэтому этот snippet является конфигурационной инструкцией, а не результатом прогона ESLint.

- **Jest:** если discovery видит `.qwen`, добавьте:

```js
testPathIgnorePatterns: ['<rootDir>/.qwen/']
```

В демо Jest не установлен. Отдельная Jest-фикстура Bughunter используется только для verifier matrix.

- **Vitest:** стандартный discovery демо действительно нашёл fixture-тесты внутри `.qwen/`. Проверенный в одноразовой копии `vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/.qwen/**'] },
});
```

Точный добавленный glob: `**/.qwen/**`. После появления project Playwright e2e в одноразовой копии в тот же массив добавляется `**/e2e/**`, чтобы Vitest не загружал Playwright specs; их запускает только Playwright/`bh_verify_red`. Не удаляйте `configDefaults.exclude` и существующие project excludes.

## 10. Разработка и проверка самого Bughunter

Зависимости каждой фикстуры не входят в dependencies сервера и ставятся отдельно только для разработки:

```sh
cd .qwen/bughunter/server
npm ci
for fixture in buggy-app jest-project vitest-project cli-probe; do
  (cd "fixtures/$fixture" && npm ci)
done
```

Основные команды из `.qwen/bughunter/server`:

```sh
npm test
npm run typecheck
node --test test/portable.bhtest.ts
```

`npm test` последовательно запускает `test/*.bhtest.ts` через `node:test`; отдельный build не требуется. Portable test копирует демо и `.qwen/` без `node_modules`, `state/runs` и `state/auth`, делает `git init`, выполняет `npm ci` в copied server/demo, проверяет project-tool isolation, поднимает скопированное демо и проходит candidate lifecycle через все 16 инструментов настоящего stdio MCP (`node src/index.ts`). Он также проверяет exported e2e red и удаляет только свою временную копию и процессы.

Не запускайте `node src/index.ts` как обычный CLI с ожиданием текстового ответа: это долгоживущий MCP stdio-сервер, stdout зарезервирован для протокола. Подключение выполняет Qwen Code через `.mcp.json` / `.qwen/settings.json`.

## 11. Проверенная совместимость CLI

### Qwen Code CLI (текущая ветка)

| Проверка | Статус |
| --- | --- |
| MCP stdio + 16 tools (automated) | PASS (`npm test`, portable copy) |
| Project skills/agents paths (`.qwen/`) | Implemented; **model gates not run** |
| Folder trust + `/mcp` approve | **PENDING / manual** |

### Kimi Code CLI 2.5.2 (архив, tag `kimi-cli-mvp`)

Проверки выполнялись на installed `kimi` **2.5.2**:

| Проверка | Статус | Фактический результат |
| --- | --- | --- |
| stdio MCP `cwd` | PASS (headless) | По умолчанию `process.cwd()` равен project root с `.git` и `.kimi-code/mcp.json`; явный `cwd` не требуется. |
| `/bughunter` shorthand | PASS (headless) | `/bughunter` разрешился в `Skill("bughunter")`. |
| Discovery project agents | PASS (headless) | Agent из `.qwen/agents/` доступен по имени. |
| Project skill внутри custom subagent | PASS (headless) | Настоящий `Agent` dispatch вызвал project `Skill`; это не доказывает соблюдение полным прогоном всей оркестрации. |
| Interactive trust | PENDING | Требуется ручной запуск и подтверждение доверия пользователем. |
| Минимальный explorer gate | PASS, исторический | 12/12 CLI exit 0, 12/12 close, 33 кандидата, 4/5 seeded bugs; кандидаты не были автоматически подтверждёнными багами. |

Доказательства Task 1 и manual explorer сохранены в fixture/run evidence. Подробные результаты автоматических этапов и финальных full/resume attempts находятся в SDD reports.

## 12. Ограничения MVP и сведённые расхождения CLI

### Границы MVP

- Только локальный запуск, Chrome и веб-приложение на настроенном дев-стенде; нет CI, npm-публикации, plugins, Cypress или других браузеров.
- Нет source maps, visual/performance checks, network-fault injection, AgentSwarm/background/parallel explorers, secondary/model overrides, автоматических commits/MR/Jira/GitLab-задач.
- Детекторы и экспорт не доказывают общую семантическую корректность приложения. Кандидат становится подтверждённым только после reproduction и review; rejected/duplicate/unreproduced не являются confirmed bugs.
- Replay изолирован свежим browser context, но общая изоляция данных приложения между повторами остаётся специфичной для приложения.
- Экспортированные signal-тесты могут зависеть от времени появления ответа/аномалии; `red` нужно проверять через `bh_verify_red`, а не считать сам факт генерации достаточным.
- Атомарность записи — per-file; нет общей транзакции или cross-process lock для одновременных writers.
- Windows `taskkill`-ветка verifier реализована, но не проверялась на текущем macOS host.
- **Главный блокер готовности:** реальная модель не соблюла требуемую последовательную custom-agent оркестрацию, а финальный two-candidate resume и interactive trust не проверены.

### Расхождения и оговорки Task 1 / installed CLI

1. **Default `cwd` stdio MCP не описан явно в документации.** Поле `cwd` опционально; фактический project-root default установлен runtime-пробой.
2. **Interactive trust не пройден.** `KIMI_CODE_TRUST_WORKSPACE=1` — механизм headless-проб, а не доказательство диалога доверия.
3. **Task 1 Agent delegation проверен только headless.** Project skill внутри subagent работает, но интерактивный dispatch может требовать подтверждения; поздние full runs отдельно показали prompt/orchestration failure.
4. **Главная страница документации вернула HTTP 403.** Использовались конкретные внутренние страницы документации.
5. **Первоначальный ручной stdio probe буферизовал первый ответ и попадал в 30-секундный timeout.** Probe переписан на `@modelcontextprotocol/sdk`; это была ошибка реализации probe, не подтверждённый продуктовый баг CLI.
6. **Installed CLI 2.5.2 отклоняет `kimi -p` вместе с `--auto` или `--yolo`.** Для записанных headless probes использовались `-p`, `--output-format stream-json` и test-scoped trust env, без `--auto`/`--yolo`.
