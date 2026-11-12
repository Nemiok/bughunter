# Bughunter BI — результаты спайков фазы 0

Дата: 2026-11-12. Статус: завершено. План: `docs/superpowers/plans/2026-11-12-bughunter-bi-phase-0-1.md`, Task 1. Спека: `docs/superpowers/specs/2026-11-12-bughunter-bi-design.md`.

Песочница: `/tmp/bh-bi-spike` (выбрасываемая, вне репозитория): Vite 6 + MSW 3.0.5 + konva 10.9.1 + three 0.187.0, страница с DOM-таблицей, Konva-графиком и three.js-сценой, данные из `GET /api/widgets` через MSW. Проверки выполнял `spike.mjs` (Playwright `chromium.launch({ channel: 'chrome', headless: true })`). Окружение: macOS arm64 (Apple M4), Chrome 156, Node v24.14.0.

Команды:

```sh
cd /tmp/bh-bi-spike && node spike.mjs                    # все проверки
cd /tmp/bh-bi-spike && node spike.mjs --check responses  # только S1
```

## S1. Видны ли ответы MSW (service worker) слушателям Playwright и читаются ли тела

Фактический вывод:

```json
{
  "seenByContext": 1,
  "seenByPage": 1,
  "allContextResponses": 13,
  "fromServiceWorker": true,
  "bodyReadable": true,
  "bytes": 247,
  "bodyError": null,
  "hookEntries": 0,
  "hookBodySample": []
}
```

Выводы:

1. Ответ, обслуженный service worker'ом MSW, **виден и контекстным, и page-слушателем**; `response.fromServiceWorker() === true` подтверждает, что это именно SW-ответ.
2. **Тело читается**: `await response.body()` вернул 247 байт без ошибки.
3. Запасной путь через хук MSW **не сработал**: `worker.events.on('response:mock', …)` не записал ни одной записи (`hookEntries: 0`) — вероятно, событие в MSW 3.0.5 называется/вызывается иначе. Для спайка это не блокирует: основной путь рабочий.

**Решение (правило ветвления из Task 1):** Task 3 строится на **контекстных слушателях Playwright** (`context.on('response')` + `response.body()`). Хук MSW остаётся документированным запасным путём, но его реализация откладывается до момента, когда он понадобится на реальном Навигаторе: в песочнице событие `response:mock` не сработало, значит сначала нужно выяснить фактический API событий MSW в версии целевого проекта, а не писать код вслепую.

**Оговорка:** проверка выполнена на MSW 3.0.5 и Chrome 156 на macOS. Версия MSW и браузер на корпоративном устройстве могут отличаться, поэтому в Task 3 предусмотрен явный сигнал `RESPONSE_SOURCE_UNAVAILABLE` вместо тихого пропуска: если тела не читаются, это видно в журнале, а не проявляется как «багов данных нет».

## S2. Читается ли граф Konva из страницы

Фактический вывод:

```json
{
  "containerFound": true,
  "containerKeys": [],
  "canvasKeys": [],
  "windowKonvaStages": 1,
  "hookWorks": true,
  "hookNodes": 6,
  "hookJsonBytes": 749,
  "hookLabels": ["Выручка: 1 234,57", "Расходы: 987,65", "Клиенты: 42,00"]
}
```

Выводы:

1. `window.Konva.stages` **доступен** даже в собранном Vite-приложении (Konva публикует глобаль) — 1 сцена найдена.
2. Обнаружение сцены через DOM **не работает**: ни контейнер `.konvajs-content`, ни `<canvas>` не несут собственных свойств, по которым можно найти stage (`containerKeys` и `canvasKeys` пусты). Значит путь «контейнер + React fiber» без глобала ненадёжен.
3. App-крючок работает и даёт ровно то, что нужно оракулу: 6 узлов, 749 байт JSON, и — главное — **текстовые подписи значений** (`"Выручка: 1 234,57"`), то есть проекцию данных canvas можно сравнивать с ответом API как текст.

**Решение:** в профиле основной путь — app-крючок (`window.__bhProfile`/экстрактор), opportunistic-путь — `window.Konva.stages`. Для `react-konva` в реальном Навигаторе наличие `window.Konva` нужно проверить отдельно (react-konva может держать свой экземпляр Konva в бандле без публикации глобала) — это остаётся открытым пунктом проверки на целевом приложении, а не в песочнице.

## S3. Рендерится ли WebGL в headless Chrome

Фактический вывод (без дополнительных аргументов запуска):

```json
{
  "contextCreated": true,
  "renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)",
  "version": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
  "sceneObjects": 3,
  "error": null
}
```

Вывод: на этой машине headless Chrome создаёт WebGL-контекст **без** `--use-gl=swiftshader`, сцена из трёх объектов строится и рендерится.

**Решение:** аргументы `--use-gl=swiftshader --enable-unsafe-swiftshader` не становятся дефолтом ядра, но поддержка произвольных launch args (Task 6) обязательна: на корпоративном устройстве без GPU может потребоваться программный рендер. Проверку на целевом устройстве фиксируем как отдельный шаг внедрения, а не как задачу этого плана.

## S4. Какой сброс сценария MSW надёжен

Фактический вывод:

```json
{
  "endpointResetRestoresSeed": true,
  "flagResetRestoresSeed": true,
  "emptyScenarioRows": [["нет данных"]],
  "pathnameUnchanged": true,
  "pathname": "/"
}
```

Проверено: данные мутировались (`POST /__mocks/mutate`), затем оба механизма вернули seed-состояние; сценарий `empty` отработал (таблица «нет данных»); `location.pathname` не менялся ни в одном случае.

**Решение:** оба механизма рабочи. Базовым остаётся **флаг сценария в storage + reload** (не загрязняет маршрут и сигнатуры, не требует эндпоинта), уточняющим — **служебный эндпоинт сброса** для сценариев, где перезагрузка ломает состояние (например, многошаговый визард). Профиль declares оба варианта через `reset.kind`, ядро поддерживает оба.

## Итоговые правила ветвления для плана

| Вопрос | Ответ | Следствие для плана |
| --- | --- | --- |
| S1 | Контекстные слушатели видят SW-ответы, тела читаются | Task 3: основной путь — `context.on('response')` + `response.body()`; хук MSW отложен; обязательный сигнал `RESPONSE_SOURCE_UNAVAILABLE` |
| S2 | `window.Konva.stages` доступен, DOM-обнаружение недоступно, app-крючок даёт текстовые подписи | Task 2/5: экстрактор профиля — основной путь; `Konva.stages` — opportunistic; проверка `react-konva` на целевом приложении выносится во внедрение |
| S3 | WebGL работает headless без доп. аргументов на macOS/M4 | Task 6: launch args настраиваемые, swiftshader не дефолт |
| S4 | Оба механизма сброса работают, pathname не меняется | Task 8: `reset.kind: 'storage-flag' \| 'mock-endpoint'`, оба поддержаны |

Песочница `/tmp/bh-bi-spike` выбрасываемая: в репозиторий не переносится, приемочной фикстурой не является. Acceptance-фикстура `bi-app` (React + react-konva + three.js + MSW с засеянными багами данных и легальными трансформациями) — задача фазы 2.

**Дополнение от 2026-11-12 (после сборки `bi-app`).** Причина несрабатывания хука найдена: в MSW 3.0.5 событие называется `response:mocked`, а не `response:mock` как в MSW 2. С исправленным именем хук работает — `window.__bhResponses` заполняется до первого fetch приложения, что проверено тестом `response hook exists before the first fetch on a cold load` (сравнение списка хука со списком ответов, наблюдаемых самим Playwright). Запасной путь из риска R1 тем самым реализован и доказан, а не только заявлен; для целевого приложения версию MSW и имя события всё равно нужно уточнять на месте.
