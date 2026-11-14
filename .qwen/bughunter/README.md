# Bughunter: веб-пресет — операторская документация

Концепция инструмента (семь инвариантов, два домена, как сделать свой пресет) — в корневом
[`README.md`](../../README.md) и в `docs/concept/`. Этот файл описывает только веб-пресет:
установку, конфигурацию, запуск, артефакты, проверку самого инструмента и ограничения.

## 1. Сначала доверьте папке проекта

**Первый шаг — folder trust для Qwen Code CLI.** Откройте терминал в корне целевого Git-проекта, запустите `qwen`, доверьте папке (или IDE workspace trust при подключении) и при необходимости подтвердите project MCP из `.mcp.json` через `/mcp` → approve. Проектные skills/agents из `.qwen/` требуют trust для `allowedTools` и hooks.

Интерактивный диалог trust **проверен вручную 2026-11-13**: пользователь открыл `qwen` в каталоге одноразовой копии, подтвердил доверие к папке, выполнил `/mcp` → approve `bughunter` и запустил `/bughunter target /profile` без headless-флагов — прогон `20261113T175433.164Z-07952730d99a` завершился `finished` (раздел 2). Для каждого нового проекта это по-прежнему первое ручное действие.

## 2. Честный статус проверки

**Автоматические проверки проходят:** `npm run typecheck` и `npm test` из `.qwen/bughunter` — **core 42/42** и веб-пресет **254 pass / 0 fail / 1 skipped (255)**, включая portable-копию (`npm ci`, настоящий MCP stdio handshake, все **19** инструментов, экспорт и red-вердикт без шага сборки), тест-запрет доменной лексики и импортов пресета в `core/src` и тест честности этой документации. Пропущенный тест — замер стоимости обхода на фикстуре `bi-app`, он запускается с `BH_BI_FULL_SWEEP=1` (см. §10).

**Модельные гейты на Qwen Code CLI 1.0.0-preview пройдены полностью:** полный и two-candidate resume (2026-11-12), интерактивный folder trust без headless-флагов (2026-11-13) и модельный smoke-прогон на BI-фикстуре (2026-11-13). Фаза 1 для крупных BI-приложений принята на фикстуре `bi-app` — см. `docs/superpowers/reports/2026-11-12-bi-app-phase1-acceptance.md`. Все четыре прогона выполнены на веб-пресете **до** разреза на core и пресеты; после разреза поведение пресета не менялось, но модельная проверка новой лексики (`target`/`sweep`, `bh_export_test`) — route-репетиция — на момент этой правки ещё не выполнена и отмечена в разделе 2 как непройденная.

**Оговорка к таблицам ниже:** в записях гейтов инструмент экспорта назван `bh_export_e2e`, потому что так он назывался на момент прогонов. Теперь он называется `bh_export_test`: имя инструмента общее для всех пресетов, а вид генерируемого теста определяет пресет.

### Полный модельный гейт 2026-11-11 — исторический (3/5, выявил дефекты 1–5)

2026-11-11, run `20261111T140255.638Z-937f1cdc7a5d`, headless `qwen -p '/bughunter full' --output-format stream-json`, длительность 3 ч 36 мин, одноразовая копия демо. Доказательства: `state/runs/qwen-full/` (JSONL, `regen-verification.json`, регенерированные спеки).

| Критерий | Результат |
| --- | --- |
| Оркестрация только через custom agents | **PASS**: 51 сообщение с инструментами и **0 батчей**; строгое чередование `bh_explore_next` → ровно один `Agent(bh-explorer)` (12 задач = 4 маршрута × 3 персоны, очередь 12/12 `done`); `bh_triage`/`bh_export_e2e`/`bh_verify_red` — только внутри `Agent(bh-reviewer)` (7 вызовов) и `Agent(bh-test-writer)` (5); главный агент использовал лишь start/explore_next/reproduce/resume/finish |
| Завершённость прогона | **PASS**: `finished`, все stages и routeStages `done`, `report.md` записан; `RUN_INCOMPLETE` от первого `bh_finish_run` обработан штатно через `bh_resume_run` |
| ≥4/5 засеянных багов подтверждено | **FAIL: 3/5** — подтверждены баг 1 (необработанное исключение при Save с пустым именем), баг 2 (HTTP 500 при Quantity=0), баг 4 (`NaN` в итоге заказов). Баг 3 (двойной клик → дубль заказа) исследователи не нашли; баг 5 (сброс фильтра страницы) был наблюден (console «Orders page filter reset»), но оформлен выдуманным инвариантом «видна ссылка Page 1» и корректно отклонён reviewer'ом |
| 0 подтверждённых ложных срабатываний | **PASS**: 2 rejected (ожидаемое поведение и недоказуемый инвариант), 2 duplicate, 1 unreproduced; подтверждённых ложных нет |
| red e2e на каждый подтверждённый баг | **FAIL в прогоне → закрыт детерминированно**: 2 из 3 спеков были red, спек `460473dd` дал green из-за гонки в экспортёре. После исправления все три спека, перегенерированные из артефактов этого прогона, красные (`3 failed` на целевом assertion) — см. `state/runs/qwen-full/regen-verification.json` |

### Финальный полный модельный гейт 2026-11-12 — PASS по всем пяти критериям

2026-11-12, run `20261112T072651.852Z-4b2ba4ccfd96`, headless `qwen -p '/bughunter full'` в одноразовой копии `bughunter-gate/full-final` (точный allow-list в `.qwen/settings.json` копии вместо `--dangerously-skip-permissions`), длительность 3 ч 59 мин. Доказательства: JSONL прогона, `run.json`, `report.md` и экспортированные спеки внутри копии.

| Критерий | Результат |
| --- | --- |
| Завершённость прогона | **PASS**: CLI exit 0, `finished`, все stages и четыре routeStages (`/`, `/orders`, `/orders/new`, `/profile`) `done`, очередь исследования 12/12, `report.md` → `Pending: None` |
| ≥4/5 засеянных багов подтверждено | **PASS: 4/5** — `e42824c7` (необработанное исключение при пустом профиле), `28dda22a` (Quantity=0 доходит до API), `18ba03ea` (`NaN` в итоге заказов), `79bd1ee9` (перезагрузка второй страницы сбрасывает фильтр). Баг 3 (двойной клик → дубль заказа) снова не подтверждён: кандидат `591d1ef4` создан, но после минимизации шаги воспроизводят не заявленный дефект, и reviewer правомерно его отклонил |
| 0 подтверждённых ложных срабатываний | **PASS**: 9 кандидатов — 5 confirmed, 2 duplicate, 2 rejected, 0 необработанных. Пятый подтверждённый (`4eebf7df`, заказ с Quantity=-5) ложным не признан: приложение экспортирует `validateOrder(quantity) { return quantity > 0 }`, эта функция покрыта тестом и ни разу не вызвана формой создания заказа, то есть правило объявлено, но не применено |
| red e2e на каждый подтверждённый баг | **PASS**: 5 спеков в `e2e/bughunter/` и 4 unit-файла. Перепроверено собственным запуском, а не со слов модели: `npx playwright test e2e/bughunter --workers=1` → **5 failed** (красные все), `npx vitest run src/orders.test.ts src/newOrderPage.test.ts src/ordersPage.test.ts src/profilePage.test.ts` → **8 failed / 1 passed** (проходит только предсуществующий тест). Код приложения побайтово не изменён |
| Оркестрация только через custom agents | **PASS**: 69 assistant-сообщений с инструментами у главного агента и **0 батчей**; строгое чередование 12 × (`bh_explore_next` → ровно один `Agent(bh-explorer)`) → `bh_explore_next`(done); всего 26 `Agent`-вызовов (12 исследователей + 14 reviewer/test-writer); `bh_triage`/`bh_export_e2e`/`bh_verify_red` главный агент не вызывал ни разу — они выполнены внутри `Agent(bh-reviewer)`/`Agent(bh-test-writer)` |

### Two-candidate resume гейт 2026-11-12 — PASS

2026-11-12, run `20261112T114339.688Z-1e5d834da4de`, копия `bughunter-gate/resume-1`, область `route /orders/new`. Прерывание SIGINT в PID самого `qwen` на стадии записи тестов (86 мин), возобновление `qwen -p '/bughunter resume <runId>'` (13 мин).

- Условие прерывания выполнено: один кандидат полностью обработан (confirmed + e2e), три не обработаны, у трёх подтверждённых тестов ещё не было; `run.status = writing_tests`.
- Прерывание реально доставлено в процесс: последний `result` прерванного JSONL содержит `"terminal_reason":"aborted_streaming"` и `"errors":["Operation aborted"]`.
- Возобновление доделало оставшееся: первый `bh_finish_run` отклонён ядром (`RUN_INCOMPLETE`), затем 3 × `Agent(bh-test-writer)` — по одному кандидату на вызов, затем успешный finish. Итог: `finished`, все стадии `done`, `Pending: None`.
- Завершённое не переделано: у всех 7 кандидатов поля `reproduction` и `review` побайтово совпадают со снапшотом `before-resume.json`.
- Тесты красные собственным запуском: 4 e2e-спека → **4 failed**; три unit-файла → **3 failed / 1 passed**.
- Оркестрация: 17 сообщений с инструментами в прерванном прогоне и 14 в возобновлённом, **0 батчей**, максимум один tool-вызов на сообщение.
- Оговорка: `Pending: None` при трёх кандидатах со статусом `unprocessed` — проектное правило ядра (`requiresWork()` в `run-store.ts`): непрепроизведённые после трёх попыток попадают в секцию отчёта `Unreproduced`, а не в `Pending`. Гейт доказал возобновление стадии записи тестов; прерывание посреди triage покрыто серверными тестами очереди и `resumeRun`, но не живым модельным прогоном.

### Интерактивный trust-гейт 2026-11-13 — PASS

2026-11-13, run `20261113T175433.164Z-07952730d99a`, одноразовая копия `/tmp/bh-trust-manual/project`, область `route /profile`, длительность 1 ч 10 мин (17:54:33 → 19:04:55 UTC). Единственный гейт, пройденный **без headless-флагов**: пользователь открыл `qwen` в каталоге копии, подтвердил folder trust, выполнил `/mcp` → approve `bughunter` и запустил `/bughunter target /profile` в интерактивной сессии; точечный allow-list и `--dangerously-skip-permissions` не использовались.

| Критерий | Результат |
| --- | --- |
| Диалог trust и подтверждение MCP | **PASS**: доверие к папке и approve `bughunter` выполнены вручную, после чего скилл, агенты и MCP-инструменты работали в интерактивной сессии |
| Завершённость прогона | **PASS**: `finished`, все стадии (`explore`, `reproduce`, `triage`, `export`) `done`, `report.md` записан, `Pending: None` |
| Кандидаты | 8 кандидатов: 3 confirmed, 3 rejected, 2 duplicate, 0 необработанных; подтверждённых ложных срабатываний нет |
| red-тесты на подтверждённые баги | **PASS, перепроверено собственным запуском 2026-11-14**: поднято демо копии на `127.0.0.1:62079`, `npx playwright test e2e/bughunter --workers=1` → **3 failed** (красные все три спека), `npx vitest run src/orders.test.ts` → **1 failed / 1 passed** (проходит только предсуществующий тест). Демо остановлено после проверки, порт свободен |

Оговорка: копия сделана до разреза на core и пресеты, поэтому её `run.json` записан в старой лексике (`scope: route`, `routes`, `routeStages`). Текущее ядро такое состояние отвергает явно — `RUN_SCHEMA_INVALID: <поле>`; миграция не предусмотрена решением автора об однократном разрыве схемы (спецификация 6.10). Доказательства прогона сохранены внутри копии (`state/runs/<runId>/`, `e2e/bughunter/`).

### Найденные и исправленные дефекты (все покрыты тестами)

1. **Порт на Qwen сломал allowlist инструментов агентов.** В `tools:` были snake_case-имена (`read_file`, `grep_search`, `glob`, `edit`, `write_file`, `skill`), а CLI оперирует PascalCase; нерезолвленные имена молча исключаются из пула субагента. Факт доказан через `system/init` в stream-json: у `bh-reviewer` в пуле оставались только MCP-инструменты — без чтения файлов и без Skill. Исправлено в трёх агентах и entry-skill, контракт закреплён в `test/prompts.bhtest.ts`.
2. **Гонка в экспортированном signal-спеке.** `expect(matched).toBe(false)` выполнялся сразу после последнего шага, до прихода ответа сети, поэтому симптом не успевал зарегистрироваться и вердикт был `green` вместо `red`. Исторически маскировалось костылём `slowMo=100` в тесте бага 2. Добавлено детерминированное ожидание `page.waitForLoadState('networkidle', { timeout: 5000 })` перед ассертом, костыль удалён.
3. **Транзиентные аномалии не наблюдались в экспорте.** Спек сканировал текст одним снимком `innerText`, тогда как живой детектор использует MutationObserver. В экспорт добавлены `exposeFunction` + `addInitScript`-наблюдатель, зеркалящие `detectors/signals.ts`; добавлен тест без искусственной задержки API.
4. **`ROUTE_NOT_ALLOWED` при экспорте легально записанного журнала.** Экспортёр требовал принадлежности пути списку `config.routes`, хотя рантайм-навигация (`SessionManager.isAllowed`) ограничена только `allowedOrigins`. Политики унифицированы: граница — разрешённый origin, а `routes` остаётся областью исследования. Это устранило `export: failed` → `RUN_INCOMPLETE`, возникшие в гейте из-за шага через `/clean`.
5. **Усилены оракулы** (`skills/bughunter-oracles`): детерминированный сигнал нельзя подменять придуманным `check` — именно так в первом гейте был потерян баг 5.

На приёмке фазы 1 на `bi-app` и в модельном smoke-прогоне найдены ещё четыре (все — RED→GREEN):

6. **`bh_crawl` терял инвентарь одностраничного приложения.** Ссылки читались сразу после `domcontentloaded`, до рендера: на `bi-app` инвентарь состоял из 1 экрана вместо 127, и обход «успешно» завершался за 1.2 с. Добавлено ожидание `networkidle` с таймаутом `limits.responseSettleMs` (пол 500 мс — меньше нельзя, Playwright считает сеть спокойной только после 500 мс тишины).
7. **`bh_sweep` не сообщал о пройденном недоступном экране.** Курсор сдвигался и находка `navigation-failed` писалась, но экран отсутствовал в возвращаемом `visited`, поэтому вызывающая сторона не отличала «недоступен и обработан» от «ещё не пройден».
8. **Текстовые `check` судили по первому совпадению в DOM, а не по видимому.** `getByText(...).first()` попадает в скрытый узел — `option` фильтра, шаблон, aria-live. Измерено на `bi-app`: для «northwest» `count()=2`, `nth(0)` — невидимый OPTION, `nth(1)` — видимая ячейка TD, из-за чего корректный кандидат трижды не воспроизвёлся. Тот же порок был в экспортёре и дал бы спек, красный после починки или зелёный при живом баге. Теперь и повтор, и экспорт перебирают совпадения в поиске видимого.
9. **Контракт `check` не был описан, а ошибка автора проглатывалась.** У `elementCount` в `target` ожидается селектор Playwright, а не текст; в схеме инструмента поле было описано как строка, в скилле оракулов `elementCount` не упоминался вовсе. Текст вместо селектора ронял `page.locator()` внутри replay, пустой `catch` превращал это в «не воспроизведено» после трёх попыток. Теперь `bh_report_candidate` разбирает селектор сразу и отвечает `CHECK_INVALID`, контракт описан в схемах обоих инструментов и в скилле.

### Что остаётся непроверенным

- **Route-репетиция после разреза core/пресеты** — **PENDING / NOT VERIFIED**: все записанные модельные прогоны выполнены до того, как область `route` стала `target`, область `screen` — `sweep`, а инструмент `bh_export_e2e` — `bh_export_test`. Новая лексика закреплена автоматическими тестами контракта промптов (`core/test/prompts-core.bhtest.ts`, `presets/web/test/prompts.bhtest.ts`), но живым модельным прогоном не проверена: нужен один прогон `/bughunter target <путь>` в одноразовой копии.
- **Баг 3 демо-фикстуры** (двойной клик → дубль заказа) не подтверждён ни в одном модельном прогоне: кандидат создаётся, но минимальные шаги после минимизации воспроизводят другой дефект. Класс «кратность эффекта» требует проверки на уровне ядра (подсчёт созданных записей), а не подсказки в промпте.
- **Оракул сверки данных** (фаза 2): на `bi-app` засеянные расхождения D1–D6 не находятся; измеренный базовый уровень — 0/6 багов данных и 1/3 поведенческих, и для 6/6 нужны три формы оракула (`response`, `projection`, `request`).
- **Прогон на настоящем Навигаторе BI** не выполнялся: все измерения получены на локальных фикстурах `127.0.0.1`. Корпоративный стенд (прокси, сертификаты, отсутствие GPU, своя версия MSW) требует повторного замера стоимости и проверки `browser.launchArgs`.

Исторические гейты на Kimi Code CLI 2.5.2 (тег `kimi-cli-mvp`) описаны в разделе 11: три попытки полного прогона не прошли требование оркестрации (батчинг `Agent`-вызовов либо полное отсутствие делегирования), что и привело к серверной очереди исследования и lease из Task 17. На Qwen Code CLI это требование выполнено с первой попытки.

## 3. Установка в проект

Требования: Git, Node.js **≥ 22.18**, npm и установленный Google Chrome. Сервер выполняет TypeScript напрямую через Node type stripping; сборка не нужна.

1. Выполните интерактивный trust из раздела 1.
2. Скопируйте из дистрибутива в `.qwen/` целевого проекта:
   - `bughunter/` целиком;
   - `skills/bughunter/` (entry), `skills/bughunter-core-contract/`, `skills/bughunter-preset-guide/`, `skills/bughunter-preset-card/` (карта веб-пресета), `skills/bughunter-oracles/`, `skills/bughunter-red-test/`;
   - `agents/bh-explorer.md`, `agents/bh-reviewer.md`, `agents/bh-test-writer.md`.
3. Добавьте в корень проекта **`.mcp.json`** (или объедините с существующим) с записью Bughunter:

```json
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": [".qwen/bughunter/presets/web/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
```

По умолчанию stdio MCP стартует с `cwd` = корень проекта. `toolTimeoutMs` оставляет время на воспроизведение и запуск тестов. Проектный сервер из `.mcp.json` подтверждается один раз: `/mcp` в интерактивной сессии или `qwen mcp enable bughunter` (сброс прежних решений — `qwen mcp reset-project-choices`). Команды `qwen mcp approve` не существует. Проверка: `qwen mcp list` показывает `✓ bughunter: node .qwen/bughunter/presets/web/src/index.ts (stdio) - Connected`.

4. Установите зависимости core и пресета из lockfile (корень workspaces):

```sh
cd .qwen/bughunter
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

6. Отредактируйте `.qwen/bughunter/presets/web/state/config.json` под целевой стенд. Поставляемый конфиг указывает на локальное демо `http://127.0.0.1:4173`. Если файла нет, первый `bh_start_run` создаст шаблон и вернёт `CONFIG_CREATED`; после заполнения конфига запустите команду заново.
7. Перезапустите `qwen` из корня проекта и проверьте `mcp__bughunter__*` (slash `/mcp` или tool list).

## 4. Chrome и авторизация

Bughunter использует **только Google Chrome** через Playwright `channel: "chrome"`; другие браузеры не поддерживаются. Установите Chrome штатным способом ОС. `playwright-core` не скачивает браузер в postinstall. Если Chrome не найден, установите его и повторите запуск; для воспроизведения артефактов video также должен быть доступен Playwright FFmpeg.

Если стенд требует входа:

```sh
cd .qwen/bughunter/presets/web
npm run auth
```

Откроется обычный (headed) Chrome на `baseUrl`. Войдите вручную, вернитесь в терминал и нажмите Enter. Сессия сохраняется в `.qwen/bughunter/presets/web/state/auth/storage-state.json` и автоматически используется новыми браузерными контекстами. Этот файл содержит секреты сессии, игнорируется Git и не должен передаваться или коммититься. Автоматические тесты не выполняли реальный интерактивный login.

## 5. Конфигурация `state/config.json`

JSON строго валидируется: неизвестные поля отклоняются. Все поля обязательны; `tests.unit.command` может быть `null`.

| Поле | Назначение |
| --- | --- |
| `baseUrl` | Абсолютный URL дев-стенда; начальная точка auth, навигации и экспортированных тестов. |
| `allowedOrigins` | Непустой список разрешённых абсолютных origin. Прямые, клиентские и popup-переходы за их пределы блокируются. |
| `routes` | Непустой список маршрутов, начинающихся с `/`; полный набор для `full` и допустимых `target`. |
| `targetMap` | Отображение glob-путей исходников на маршруты для `diff`, например `"src/pages/orders/**": ["/orders", "/orders/new"]`. |
| `baseBranch` | Базовая ветка для `git diff --name-only <baseBranch>...HEAD`. |
| `profile` | Необязательное имя профиля приложения из `state/profiles/<name>/index.ts`. Профиль описывает экстракторы виджетов, привязки оракулов, контракт полей, рецепт сброса данных, каталог тестовых файлов и аргументы запуска браузера. Без поля профиль не загружается; ошибки — `PROFILE_NOT_FOUND` и `PROFILE_INVALID` с именем поля. |
| `browser.launchArgs` | Необязательный список аргументов запуска Chrome (не более 64). Аргументы профиля добавляются после конфиговых и побеждают при совпадении имени флага. Запрещены `--disable-web-security`, `--allow-running-insecure-content`, `--unsafely-treat-insecure-origin-as-secure` и `--remote-debugging-port` — ошибка `LAUNCH_ARG_FORBIDDEN`. `--no-first-run` и `--no-default-browser-check` добавляются всегда. |
| `browser.proxy` | Необязательный прокси (`http://host:port`) для запуска Chrome — для корпоративных стендов. |
| `browser.ignoreHTTPSErrors` | При `true` браузерный контекст игнорирует ошибки HTTPS (корпоративные сертификаты). По умолчанию `false`. |
| `limits.stepsPerSession` | Положительный целый общий лимит действий, переходов и probes в одной сессии. |
| `limits.candidatesPerRun` | Положительное целое для лимита кандидатов на прогон. В текущем MVP поле валидируется, но отдельное enforcement этого лимита ещё не реализовано. |
| `limits.elementsPerSnapshot` | Необязательное положительное целое (не более 2000), сколько элементов снимка `bh_state` отдаёт за вызов; по умолчанию 120. Элементы ранжируются (пересечение с viewport → роль → позиция), остаток доступен через `cursor`, а `totalVisible`/`truncated`/`nextCursor` показывают, что список отдан не целиком. |
| `limits.responseSettleMs` | Необязательное целое (0–60000), сколько миллисекунд детерминированные обходы ждут успокоения сети на экране: `bh_sweep` — перед чтением структуры экрана, `bh_crawl` — перед сбором ссылок (одностраничное приложение рисует их позже загрузки документа). По умолчанию 2500; значения меньше 500 в `bh_crawl` поднимаются до 500, потому что Playwright считает сеть спокойной только после 500 мс тишины. |
| `limits.screensPerSweep` | Необязательное положительное целое (не более 2000), сколько экранов `bh_sweep` проходит за один вызов; по умолчанию 25. Остальное продолжается следующим курсором. |
| `safety.forbiddenActionText` | Строки запрещённого текста/имени элемента; сравнение нечувствительно к регистру до выполнения действия. |
| `safety.readOnly` | При `true` дополнительно блокирует explicit/implicit submit и связанные Enter/NumpadEnter. |
| `testDataPrefix` | Префикс автоматически генерируемых тестовых значений, например `bh_`. |
| `detectors.ignoreConsole` | Строки-исключения для console-сигналов. |
| `detectors.ignoreRequests` | Строки-исключения для network request/response-сигналов. |
| `detectors.anomalyTexts` | Токены аномального видимого текста, например `undefined`, `NaN`, `[object Object]`, `Invalid Date`. |
| `detectors.errorBoundarySelector` | Непустой CSS selector error boundary. |
| `tests.unit.command` | Явная команда project-local Jest/Vitest или `null` для автодетекции; verifier добавляет один файл и обязательные reporter-аргументы. |
| `tests.generated.dir` | Каталог экспорта Playwright-тестов относительно ближайшего project root с `@playwright/test`. |

Для изолированных тестов сервер принимает `BUGHUNTER_STATE_DIR`; без него состояние всегда вычисляется от расположения `presets/web/`, а не от текущего каталога.

Рабочий пример профиля — `fixtures/bi-app/bughunter-profile/index.ts` (профиль `bi`, на нём принята фаза 1). Три вещи, которые стоит повторить в своём профиле:

- скрипт экстрактора сначала спрашивает приложение, есть ли виджет на этом экране, и возвращает `null`, если нет: обход вызывает все экстракторы профиля на каждом экране и пишет находку `extract-failed` на любую ошибку, поэтому наивный экстрактор засыпал бы отчёт ложными находками;
- `oracles[].urlPattern` сопоставляется как подстрока URL (`CapturedResponse.url.includes(pattern)`), шаблоны вида `/api/x/:id` не работают;
- `interactions.resolvePoint` называет цель для координатных действий там, где в DOM под точкой остаётся canvas: без хука приложения `clickAt` по столбцу графика дал бы `POINT_TARGET_UNRESOLVED`.

Замеры стоимости обхода на этом профиле — `fixtures/bi-app/ACCEPTANCE.md`.

## 6. Запуск и возобновление

Команды вводятся внутри интерактивной сессии `qwen` из корня целевого проекта (skill `/bughunter` или `/skill:bughunter`):

| Команда | Поведение |
| --- | --- |
| `/bughunter` или `/bughunter diff` | Scope по умолчанию. Сопоставляет изменённые относительно `baseBranch` файлы с `targetMap`; если совпадений нет, проверяет все `routes`. |
| `/bughunter full` | Последовательно проверяет все настроенные `routes` тремя персонами. |
| `/bughunter target /orders` | Проверяет один маршрут; он должен присутствовать в `routes`. |
| `/bughunter sweep <template>` | Детерминированный обход одного экрана из инвентаря, например `/orders/:id`. Очередь исследования не строится: экран проходит `bh_sweep`, модель разбирает только находки. |
| `/bughunter sweep` | Детерминированный обход всего инвентаря экранов. Сначала `bh_crawl` строит `state/screens.json`, затем `bh_sweep` вызывается повторно, пока не вернёт `done: true`; курсор сохраняется после каждого экрана. |
| `/bughunter resume <runId>` | Продолжает существующий прогон по сохранённым `targets`, `targetStages` и состоянию кандидатов, не создавая новый run и не повторяя завершённую работу. Для области `sweep` продолжает обход с сохранённого курсора. |

Детерминированные области не расходуют модель на обход: `bh_sweep` на каждом экране выполняет сброс данных по рецепту профиля, переход, ожидание ответов, сбор структуры экрана экстракторами профиля и пишет находки (`response-captured`, `response-missing`, `extract-failed`, `navigation-failed`, `reset-unsupported`). Находка не кандидат: `bh_triage` по её id вернёт `FINDING_NOT_CANDIDATE`. В кандидата её превращает `bh_promote_finding` (нужен `check`), после чего работают обычные `bh_reproduce`, reviewer и test-writer. `bh_finish_run` для области `sweep` требует `stages.sweep === 'done'`, а не стадий целей по всем `targets`.

`/bughunter` — shorthand для `/skill:bughunter`. Entry skill вызывается только вручную. Требуемый workflow: серверная очередь исследования выдаёт по одной паре маршрут–персона вместе с lease (`bh_explore_next`); главный агент делегирует каждую задачу одному foreground custom agent `bh-explorer`, затем воспроизводит каждого кандидата, вызывает отдельного reviewer и test-writer только для подтверждённых багов и завершает `bh_finish_run` без pending работы. `bh_open` без действующего lease отклоняется (`LEASE_REQUIRED`/`LEASE_UNKNOWN`/`LEASE_MISMATCH`), а одновременная сессия блокируется `EXPLORER_BUSY`, поэтому параллельные исследователи невозможны независимо от поведения модели. Реальное несоответствие этому workflow до введения очереди зафиксировано в разделе 2.

Bughunter не должен коммитить или менять код приложения. Headless-прогоны Qwen Code зависят от вашей установки (`qwen -p`, approvals, trust). Модельные гейты на Qwen Code CLI 1.0.0-preview записаны в разделе 2: полный и resume — headless с точечным allow-list в одноразовой копии, trust-гейт — в интерактивной сессии без headless-флагов. Исторические пробы на Kimi Code CLI — tag `kimi-cli-mvp` и раздел 11.

## 7. Артефакты и состояние

Все рабочие данные находятся в `.qwen/bughunter/presets/web/state/`:

- `config.json`, `known-bugs.json`, `suppressions.json` — конфигурация и общая signature-память; предназначены для совместного version control.
- `runs/<runId>/run.json` — scope, выбранные цели (`targets`), статусы прогона, стадий (`stages`) и целей (`targetStages`) для resume.
- `runs/<runId>/candidates/<candidateId>.json` — кандидаты, reproduction/review и пути созданных тестов.
- `runs/<runId>/journals/<sessionId>.json` — семантические действия и сигналы.
- `runs/<runId>/artifacts/<candidateId>/` — `trace.zip`, `screenshot.png`, `video.webm`; у reproduction могут быть подкаталоги `replay-*`.
- `runs/<runId>/e2e/` — экспорт, если в проекте не найден `@playwright/test`; иначе файлы попадают в `tests.generated.dir`.
- `runs/<runId>/responses/<hash>.body` — тела ответов приложения, захваченные в сессии или обходе; в журнале шага остаются только хэши (`responseHashes`).
- `runs/<runId>/findings/<findingId>.json` — находки детерминированного обхода (не кандидаты).
- `runs/<runId>/sweep.json` — чекпоинт обхода: `visited`, `cursor`, время старта и обновления.
- `runs/<runId>/report.md` — confirmed/rejected/duplicates/unreproduced/pending, минимальные шаги, артефакты и тесты; у прогонов с находками добавляется секция `## Findings`.
- `screens.json` — инвентарь экранов, построенный `bh_crawl`: шаблон маршрута, пример URL, откуда экран найден, виджеты профиля и время последней проверки. Файл накапливаемый: повторный обход дополняет записи, а повреждённый JSON даёт `SCREENS_STORE_CORRUPT` вместо тихой перезаписи.
- `profiles/<name>/index.ts` — модуль профиля приложения (экстракторы виджетов, привязки оракулов, контракт полей, рецепт сброса, каталог тестовых данных, аргументы браузера).
- `auth/storage-state.json` — локальная auth-сессия.

`state/runs/` и `state/auth/` игнорируются локальным `.qwen/bughunter/.gitignore`. Их нельзя удалять при обычном обновлении: там могут быть незавершённые прогоны, доказательства gates и auth. Fixture Playwright output `.playwright-output/` также игнорируется.

## 8. Перенос и обновление без потери состояния

При переносе на другую машину/репозиторий копируйте `bughunter/`, шесть skill-каталогов и три agent-файла, затем заново объедините `mcp.json` и выполните `npm ci` в `.qwen/bughunter`. Скопируйте существующий `state/` отдельно, если нужны общая память и resume; `auth/` лучше создать заново через `npm run auth`, а не переносить секреты.

**Для обновления заменяйте только `.qwen/bughunter/core/` и `.qwen/bughunter/presets/`.** Не удаляйте и не перезаписывайте `.qwen/bughunter/presets/web/state/`. После замены выполните `cd .qwen/bughunter && npm ci`. Не копируйте новый `bughunter/` поверх установки целиком: это может затереть config, known/suppressions, runs и auth.

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
cd .qwen/bughunter
npm ci
for fixture in buggy-app jest-project vitest-project cli-probe bi-app; do
  (cd "fixtures/$fixture" && npm ci)
done
```

Основные команды из `.qwen/bughunter/presets/web`:

```sh
npm test
npm run typecheck
node --test test/portable.bhtest.ts
```

`npm test` из корня `.qwen/bughunter` запускает наборы обоих workspace-пакетов: core (`core/test/*.bhtest.ts`, 42 теста — метод, очередь, воспроизведение, обход, экспорт, конфиг, граница и промпт-контракт) и веб-пресет. Отдельный build не требуется.

У фикстуры `bi-app` есть собственный набор, который не входит в `npm test` пресета (он запускается vitest из каталога фикстуры):

```sh
cd fixtures/bi-app && npx tsc --noEmit && npx vitest run     # датасеты, засеянные баги, легальные трансформации
cd ../.. && env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts            # фикстура глазами ядра
env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app-acceptance.bhtest.ts             # приёмка фазы 1 (~2.5 мин)
BH_BI_FULL_SWEEP=1 env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app-acceptance.bhtest.ts   # + замер стоимости, перезаписывает fixtures/bi-app/ACCEPTANCE.md
```

`npm test` последовательно запускает `test/*.bhtest.ts` через `node:test`; отдельный build не требуется. Portable test копирует демо и `.qwen/` без `node_modules`, `state/runs` и `state/auth`, делает `git init`, выполняет `npm ci` в copied server/demo, проверяет project-tool isolation, поднимает скопированное демо и проходит candidate lifecycle через все 19 инструментов настоящего stdio MCP (`node src/index.ts`). Он также проверяет exported e2e red и удаляет только свою временную копию и процессы.

Не запускайте `node src/index.ts` как обычный CLI с ожиданием текстового ответа: это долгоживущий MCP stdio-сервер, stdout зарезервирован для протокола. Подключение выполняет Qwen Code через `.mcp.json` / `.qwen/settings.json`.

### Headless-прогон модельного гейта

Модельные гейты воспроизводятся без интерактивной сессии. Одноразовая копия готовится так же, как в `test/portable.bhtest.ts` (`copyPortableProject`, `availablePort`, `startDemo`, `demoConfig`), но размещается **вне** `.qwen/` (см. раздел 12):

```sh
ROOT=$(pwd); GR="$ROOT/bughunter-gate/full-2"; G="$GR/project"
mkdir -p "$G"
rsync -a --exclude node_modules --exclude .playwright-output .qwen/bughunter/fixtures/buggy-app/ "$G/"
rsync -a --exclude node_modules --exclude 'state/runs' --exclude 'state/auth' \
      --exclude 'settings.local.json' .qwen/ "$G/.qwen/"
cp .mcp.json "$G/.mcp.json"
cd "$G" && git init -b main && npm ci --no-audit --no-fund \
  && (cd .qwen/bughunter && npm ci --no-audit --no-fund)
# vitest.config.ts копии: test.exclude = [...configDefaults.exclude, '**/.qwen/**', '**/e2e/**']
# .qwen/settings.json копии: permissions.allow = mcp__bughunter__*, Agent, Skill, Read, Grep, Glob, Edit, Write
# .qwen/bughunter/presets/web/state/config.json копии: baseUrl/allowedOrigins = свободный порт, routes из области проверки
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort > "$GR/demo.log" 2>&1 &
```

Прогон из корня копии:

```sh
cd "$G" && caffeinate -i qwen -p '/bughunter full' --output-format stream-json \
  --no-session-persistence --allowed-mcp-server-names bughunter \
  > "$GR/qwen-full.stdout.jsonl" 2> "$GR/qwen-full.stderr.log"
```

`--dangerously-skip-permissions` не требуется, если в копии лежит указанный allow-list. Полный прогон занимает порядка 3.5 часов: 12 explorer-сессий примерно по 15 минут плюс reproduce, review и test-writer. `caffeinate -i` обязателен — при idle-sleep машины таймауты verifier растягиваются в десятки раз. Прерывать прогон нужно SIGINT в PID самого `qwen`, а не процесса-обёртки.

Разбор JSONL: `system/init` даёт фактический пул инструментов и список скиллов; батчинг определяется группировкой `tool_use` по `message.id` — несколько инструментов с одним `message.id` означают нарушение требования «один вызов на сообщение».

## 11. Проверенная совместимость CLI

### Qwen Code CLI 1.0.0-preview (текущая ветка)

| Проверка | Статус | Фактический результат |
| --- | --- | --- |
| Typecheck + 19 tools (automated) | PASS | `npm run typecheck` в обоих пакетах; `npm test` из `.qwen/bughunter`: core 42/42 и пресет 254 pass / 0 fail / 1 skipped (255) за ~330 с; portable-копия проходит stdio handshake всех 19 инструментов |
| Project skills discovery | PASS | `qwen skills list`: шесть скиллов Enabled — `bughunter` (entry, `disable-model-invocation`), `bughunter-core-contract`, `bughunter-preset-guide`, `bughunter-preset-card`, `bughunter-oracles`, `bughunter-red-test` |
| Project agents discovery | PASS | `qwen agents list`: `bh-explorer`, `bh-reviewer`, `bh-test-writer` (Project, model Inherit) |
| `/bughunter` shorthand headless | PASS | `qwen -p '/bughunter __probe__' --output-format stream-json`: `Skill **bughunter** activated.`, `$ARGUMENTS` передан, невалидный аргумент остановил прогон за один turn без tool-вызовов |
| Project skill внутри custom subagent | PASS | `qwen -p --agent bh-reviewer …`: вызов `Skill {"skill":"bughunter-oracles"}` вернул содержимое скилла |
| Имена встроенных инструментов | PASS | Пул сессии — PascalCase (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `Skill`, `Agent`, `Bash`); snake_case-имена в `tools:` молча выпадают из пула субагента |
| Полные модельные гейты (full / resume) | PASS | 2026-11-12: full run `20261112T072651.852Z-4b2ba4ccfd96` — 4/5 засеянных багов, 0 подтверждённых ложных, 5 красных e2e, 0 батчей в 69 сообщениях; resume run `20261112T114339.688Z-1e5d834da4de` — обработанное не переделано, оставшееся доделано, 4 красных e2e. Подробно в разделе 2 |
| Модельный прогон на BI-фикстуре | PASS (smoke) | 2026-11-13: `route /dashboard/1` на `bi-app` с профилем `bi`, копия `bughunter-gate/bi-smoke`, run `20261113T131557.204Z-68c505592f97` — 75.3 мин, exit 0, **0 батчей** в 86 assistant-сообщениях, 0 ошибок контракта; 10 кандидатов → 3 confirmed / 3 rejected / 4 `unreproduced`, **0 подтверждённых ложных**; 3 красных e2e-спека и 2 красных unit-теста, перепроверенные независимым запуском (`3 failed`, `2 failed`). Среди подтверждённых — два засеянных бага данных (D1, D5), найденных моделью **без** оракула фазы 2, и дефект X1 сверх засеянного. Подробно в `docs/superpowers/reports/2026-11-12-bi-app-phase1-acceptance.md` (§6) |
| Folder trust (интерактивный) + `/mcp` | PASS | 2026-11-13: пользователь подтвердил folder trust и `/mcp` → approve `bughunter` в одноразовой копии `/tmp/bh-trust-manual/project`, затем `/bughunter target /profile` в интерактивной сессии **без headless-флагов** — run `20261113T175433.164Z-07952730d99a`, `finished` за 1 ч 10 мин, 8 кандидатов → 3 confirmed / 3 rejected / 2 duplicate, 3 красных e2e и 1 красный unit-тест (перепроверено собственным запуском 2026-11-14). Подробно в разделе 2 |
| Модельная проверка лексики после разреза core/пресеты | **PENDING** | Route-репетиция `/bughunter target <путь>` после переименований `route`→`target`, `screen`→`sweep`, `bh_export_e2e`→`bh_export_test`; автоматические контракт-тесты зелёные, живой прогон не выполнен |

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
- Экспортированные signal-тесты детерминированно дожидаются завершения сети (`networkidle` с ограниченным таймаутом) и наблюдают транзиентные аномалии через MutationObserver, но окончательный вердикт даёт только `bh_verify_red`; сам факт генерации файла достаточным не считается.
- Атомарность записи — per-file; нет общей транзакции или cross-process lock для одновременных writers.
- Windows `taskkill`-ветка verifier реализована, но не проверялась на текущем macOS host.
- Одноразовую копию для модельных гейтов нельзя размещать внутри `.qwen/`: Qwen Code CLI относит такие пути к чувствительным и отклоняет `Write`/`Edit` субагента («This file path is sensitive and requires explicit approval»), из-за чего `bh-test-writer` не может ни создать unit-тест, ни поправить спек. Проверено: копия в `bughunter-gate/` (вне `.qwen`, каталог в `.gitignore`) записывается штатно.
- Профиль приложения и детерминированный обход — граница фазы 1: `bh_sweep` собирает проекции виджетов и захваченные ответы, но **не сверяет** их между собой. Оракулы «ответ API ↔ проекция в UI», контракт полей и областные подавления планируются фазой 2; до них находка `response-captured` означает «ответ получен и сохранён как артефакт», а не «данные на экране верны».
- `iframe` и shadow DOM не обходятся: снимок, координатные действия и обход работают в основном документе.
- Инвентарь `screens.json` строится по ссылкам `a[href]`: экраны, достижимые только действием (открытие виджета, клиентский роутинг без ссылок), в него не попадают. Записи инвентаря сериализованы внутри одного процесса сервера; два процесса на одном `stateDir` — «последний выиграл».
- Файл для действия `upload` берётся строго из `profile.testData.dir`; произвольный путь машины отклоняется как `UPLOAD_FILE_NOT_FOUND`, а в журнале и экспорте остаётся путь, разрешённый на момент экспорта.
- Профиль загружается один раз на процесс MCP-сервера: правка `profiles/<name>/index.ts` подхватывается только после перезапуска CLI.
- **Статус модельных гейтов (по фактическим прогонам на Qwen Code CLI):** полный гейт пройден — 4 из 5 засеянных багов подтверждены, 0 подтверждённых ложных срабатываний, 5 красных e2e и 8 красных unit-проверок (перепроверено собственным запуском, не со слов модели), 0 батчей в 69 сообщениях главного агента, triage/export/verify — только внутри субагентов; two-candidate resume гейт пройден — прерывание на стадии записи тестов, завершённая работа не переделана (7/7 кандидатов побайтово по `reproduction`/`review`), оставшиеся три подтверждённых получили тесты после возобновления, 4 красных e2e. Интерактивный folder trust пройден 2026-11-13 в сессии без headless-флагов (run `20261113T175433.164Z-07952730d99a`, раздел 2). Непроверенной остаётся модельная лексика после разреза на core и пресеты (`target`/`sweep`, `bh_export_test`): нужна route-репетиция живым прогоном.
- Фаза 1 принята на фикстуре `bi-app`: 127 экранов в инвентаре, 0.48 с на экран в `bh_sweep`, 0 сбойных находок, снимок держит лимит и пагинируется, `drag`/`clickAt`/`scroll` работают на реальных виджетах. **Детерминированным ядром** засеянные расхождения в данных D1–D6 не находятся — это измеренный базовый уровень для фазы 2, а не дефект обхода (`fixtures/bi-app/ACCEPTANCE.md` и `SEEDED.md`). Модельный smoke-прогон нашёл D1 и D5 **без** оракула: исследователь сам пересчитал сумму видимых строк проекции и увидел дубль строки, оба бага доказаны красными тестами. Значит оракул фазы 2 нужен не чтобы «начать находить» этот класс, а чтобы находить его детерминированно, дёшево и на всех экранах; D2, D3, D4 и D6 не найдены ни ядром, ни моделью.
- Гонки устаревших ответов через ядро не воспроизводятся: `act` ждёт успокоения сети между действиями, поэтому быстрая последовательность действий сериализуется и устаревший ответ успевает прийти до следующего действия. Класс требует режима действий без ожидания.
- Снимок собирает только интерактивные элементы (form controls, `a[href]`, `[tabindex]`, элементы с ролью): текст и состояние неинтерактивных узлов модель видит исключительно через проекции профиля. На дашборде `bi-app` это 8–19 элементов, то есть без экстракторов профиля BI-экран для модели почти пуст.
- Захват ответов не различает API и служебный трафик: на dev-стенде основную массу составляют модули сборщика (медиана 43 ответа на экран, максимум 82 на `bi-app`), поэтому эталонный набор требует фильтра по префиксу API — иначе артефакты `responses/` раздуваются, а сверка тонет в шуме.
- React StrictMode в dev-сборке вызывает эффекты дважды, поэтому сигналы приходят парами (два идентичных `response` на один HTTP 500). Дедупликация по сигнатуре есть у кандидатов, но не у сигналов.

### Расхождения Qwen Code CLI 1.0.0-preview

Зафиксировано headless-пробами `qwen -p … --output-format stream-json`; сырые JSONL сохранены в `state/runs/qwen-cli-probe/`.

1. **Встроенные инструменты имеют PascalCase-имена** (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `Skill`, `Agent`, `Bash`). Snake_case-имена (`read_file`, `grep_search`, `glob`, `edit`, `write_file`, `skill`) в `tools:` не резолвятся и молча исключаются из пула субагента: в `system/init` такого агента остаются только MCP-инструменты, сообщение об ошибке не выводится.
2. **`tools:` во frontmatter агента не ограничивает MCP-инструменты.** `bh-reviewer`, объявляющий единственный `mcp__bughunter__bh_triage`, в `system/init` получает все 16 `mcp__bughunter__*`. Разделение ответственности между агентами держится только на тексте промптов и серверных guard'ах (`CANDIDATE_UNREPRODUCED`, `RUN_INCOMPLETE`, lease/`EXPLORER_BUSY`), а не на allowlist CLI.
3. **Headless-флаги отличаются от Kimi.** Доступны `-p`, `--output-format stream-json`, `--agent <name>`, `--agents <json>`, `--no-session-persistence`, `--allowed-mcp-server-names`, `--permission-mode {default,accept_edits,bypass_permissions,dont_ask,auto}` и `--dangerously-skip-permissions`. Аналога `KIMI_CODE_TRUST_WORKSPACE` нет: доверие к каталогу задаётся `permissions.trustDirectories` в settings либо интерактивным диалогом.
4. **`qwen mcp approve` не существует.** Подтверждение проектного MCP: `/mcp`, `qwen mcp enable <name>`, `qwen mcp reset-project-choices`.
5. **`/bughunter` резолвится без префикса `/skill:`**, `$ARGUMENTS` передаётся в скилл.

### Расхождения и оговорки Task 1 / installed CLI

1. **Default `cwd` stdio MCP не описан явно в документации.** Поле `cwd` опционально; фактический project-root default установлен runtime-пробой.
2. **Interactive trust не пройден.** `KIMI_CODE_TRUST_WORKSPACE=1` — механизм headless-проб, а не доказательство диалога доверия.
3. **Task 1 Agent delegation проверен только headless.** Project skill внутри subagent работает, но интерактивный dispatch может требовать подтверждения; поздние full runs отдельно показали prompt/orchestration failure.
4. **Главная страница документации вернула HTTP 403.** Использовались конкретные внутренние страницы документации.
5. **Первоначальный ручной stdio probe буферизовал первый ответ и попадал в 30-секундный timeout.** Probe переписан на `@modelcontextprotocol/sdk`; это была ошибка реализации probe, не подтверждённый продуктовый баг CLI.
6. **Installed CLI 2.5.2 отклоняет `kimi -p` вместе с `--auto` или `--yolo`.** Для записанных headless probes использовались `-p`, `--output-format stream-json` и test-scoped trust env, без `--auto`/`--yolo`.
