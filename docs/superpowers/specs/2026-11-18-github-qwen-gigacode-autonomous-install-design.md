# GitHub-дистрибуция и автономная установка Bughunter для Qwen/GigaCode — дизайн

Дата: 2026-11-18.

## 1. Контекст

Bughunter уже собирается как самодостаточный нативный Qwen-плагин с MCP, семью skills, шестью
агентами и пресетами web/node. Локальная установка и установка из локального custom marketplace
проверены на Qwen Code CLI `1.0.0-preview.1`. Публичного GitHub remote, опубликованного релиза и
официального marketplace listing нет. Текущий marketplace first-run останавливается на
`CONFIG_CREATED` и просит оператора заполнить JSON вручную.

Новый целевой сценарий: пользователь даёт агенту адрес Bughunter на GitHub и цель проверки, а агент
сам устанавливает плагин, настраивает проект и запускает прогон. Вопросы задаются только о сведениях,
которые нельзя надёжно вывести из запроса или проекта. В Qwen допускается один технический
`/plugins reload`; ручное редактирование конфигурации не допускается.

Qwen-совместимые форки учитываются отдельно. GigaCode CLI документирует `/extensions`,
`gigacode-extension.json`, extension skills/agents и пути `.gigacode/`. Это основание добавить
capability surface, но не доказательство совместимости Bughunter: реальный GigaCode runtime на машине
автора не установлен и должен быть проверен отдельно.

## 2. Цель и границы

### Цель

Публичный GitHub-репозиторий Bughunter выпускает проверенные, самодостаточные артефакты. Пользователь
пишет, например: «Установи Bughunter из owner/bughunter и проверь /orders». Агент самостоятельно:

1. определяет возможности текущего CLI;
2. выбирает совместимый full-артефакт;
3. устанавливает и включает его;
4. проверяет prerequisites и конфликты;
5. задаёт необходимые вопросы и создаёт конфигурацию;
6. после одного host-specific refresh проверяет MCP и запускает выбранный `target`;
7. возвращает runId, отчёт и независимо проверенные красные тесты.

`owner/bughunter` здесь и далее обозначает фактический GitHub owner и имя репозитория. Реальный адрес
появляется в пользовательских инструкциях только после создания репозитория; выдуманный URL не
считается публикацией.

### Не входит в этот этап

- официальный/curated marketplace listing и его модерация;
- новые Kimi или Claude изменения, не нужные общему payload;
- автоматический запуск Bughunter без явного пользовательского запроса;
- проверка реального корпоративного приложения без отдельного разрешения;
- автоматическая установка системных программ без подтверждения пользователя;
- кросс-хостная миграция state или resume;
- незаметная замена full-пакета на MCP-only;
- push или публикация как побочный эффект build/test/release-команды.

## 3. Выбранная дистрибуция

### GitHub source, Releases и custom marketplace

Выбран вариант **GitHub Release + собственный marketplace-каталог**.

Публичный репозиторий содержит исходники, release tooling и источник marketplace-метаданных. Каждый
релиз с semver-тегом содержит:

- самодостаточный ZIP для каждого выпускаемого host/artifact;
- SHA256 каждого ZIP;
- marketplace catalog, ссылающийся на versioned HTTPS archive и его SHA256;
- `COMPATIBILITY.md` и `support-matrix.json` с фактическими evidence;
- source commit и список tools/skills/agents;
- MIT License и third-party notices для bundled production dependencies.

Production dependencies находятся в ZIP, а не коммитятся как сгенерированный `node_modules` в основную
историю. Пользователю не нужны clone, build или `npm install`.

Custom marketplace — это собственный каталог Bughunter, добавляемый агентом через нативный CLI. Он не
называется официальным каталогом Qwen, GigaCode, Gemini или Anthropic.

Прямая установка HTTPS ZIP остаётся аварийным диагностическим каналом. Если заявленный marketplace
archive-source не работает на Qwen `1.0.0-preview.1`, release gate красный: необходимо исправить
упаковку/канал, а не молча заменить marketplace установкой из исходников или выдать путь за рабочий.

### Provenance при обновлении каталога

ZIP и model evidence связываются с `payloadCommit`. Если публикация ZIP требует последующего коммита,
который меняет только marketplace URL/SHA256, этот коммит является `catalogCommit` и не меняет
`payloadCommit`. Release metadata хранит оба значения. Каталог не входит в собственный ZIP, поэтому
циклической зависимости хеша нет. Нельзя после catalog-only commit ошибочно требовать
`payloadCommit == HEAD`; равенство проверяется на этапе сборки payload, а catalog diff обязан быть
ограничен release metadata.

## 4. Capability-based выбор клиента

### Версия — evidence, не единственный gate

Имя и версия клиента записываются в evidence, но не определяют совместимость в одиночку. Форк может
иметь другое имя бинаря, команды и manifest при той же кодовой базе Qwen.

До установки агент выполняет read-only preinstall probe:

1. доступные бинарь и команды `plugins`/`extensions`;
2. поддерживаемые install sources и scopes;
3. поддерживаемые manifest names и component declarations;
4. декларируемые MCP, skills и custom agents выбранного артефакта;
5. документированные переменные plugin/extension root и workspace path;
6. доступные команды reload/refresh.

По этим результатам выбирается кандидат артефакта, а не по строке версии. После установки и до setup/run
отдельный runtime probe без записи в проект проверяет фактический cwd/env MCP spawn, разрешение рабочего
проекта, MCP handshake, component/tool counts, host-specific refresh, имена built-in tools и MCP prefix.
Dormant handshake не вызывает `bh_setup` и не создаёт state.

Неизвестный Qwen-совместимый форк проходит тот же двухэтапный probe. Отсутствие необязательной команды
не блокирует установку, если остальные компоненты полного workflow доступны. Runtime mismatch после
установки не скрывается: агент не начинает setup/run и сообщает конкретную недостающую возможность.

### Артефакты

| Surface | Manifest/канал | Project state | Условие заявления |
| --- | --- | --- | --- |
| Qwen `plugins` | `.claude-plugin/plugin.json`, native marketplace | `.qwen/bughunter/state/<preset>/` | Существующий deterministic gate плюс новый public GitHub install и model gates |
| Qwen `extensions` | `qwen-extension.json`, supported extension source | `.qwen/bughunter/state/<preset>/` | Отдельные full component, workspace и model gates |
| GigaCode `extensions` | `gigacode-extension.json`, supported extension source | `.gigacode/bughunter/state/<preset>/` | Реальный GigaCode install/component/workspace/model gates |

Qwen Agent Plugins v1 `bughunter-mcp` остаётся отдельным MCP-only артефактом и не используется как
замена перечисленным full-пакетам. Текущий blocked workspace status нельзя скрыть новым общим
extension названием.

GigaCode получает собственный descriptor только для host paths, manifest, tool vocabulary, namespace и
runtime bridge. Core и пресеты не получают `if gigacode`/`if qwen`. Если GigaCode наследует общий Qwen
extension payload, переиспользуется общий server, но manifest и project state остаются различимыми.

### Fail closed при недостатке возможностей

Ошибка называет возможность, а не просто версию, например:

```text
CLIENT_CAPABILITY_MISSING: custom agents unavailable
CLIENT_CAPABILITY_MISSING: workspace project cannot be resolved
CLIENT_CAPABILITY_MISSING: full extension archive install unavailable
```

Нет автоматического fallback на MCP-only, ручной `.mcp.json` или запись в чужой host state. Если
full-артефакт не может работать, агент сообщает ограничение и останавливается до выбора пользователя.

## 5. Компоненты

### Host descriptors и capability report

Descriptor описывает известные свойства host; capability report фиксирует фактически обнаруженные
свойства текущего CLI. Они не смешиваются: наличие descriptor не означает runtime support.

Capability report содержит клиента, версию, бинарь, выбранный artifact, команды install/refresh,
поддержанные components, способ разрешения project root и результат MCP handshake. Секреты, tokens и
содержимое auth в отчёт не попадают.

### `setup-cli.mjs`

В full-пакет добавляется CLI-точка над существующим `setupProject()` и canonical
`webConfigTemplate()`/`nodeConfigTemplate()`. Она доступна сразу после установки, до загрузки MCP в
текущую сессию.

Команды setup CLI:

- create: создать host opt-in, config template и state `.gitignore`;
- validate: проверить существующие opt-in/config и обязательные profiles без записи;
- print: вернуть JSON с host paths и installPath для агента.

Create использует атомарные no-overwrite writes и откатывает только файлы, созданные текущим вызовом.
Validate не создаёт state, runs или auth и не меняет config. Существующий dormant `bh_setup` сохраняется
как fallback для уже загруженного marketplace-плагина и использует тот же `setupProject()`, а не вторую
реализацию.

Setup CLI не является MCP stdio server и не запускает исследование. MCP stdout по-прежнему reserved для
protocol; CLI JSON output относится только к отдельному setup entrypoint.

### Entry и setup prompts

Prompt layer получает отдельные инструкции для:

1. установки по versioned public `INSTALL.md` до появления plugin tools;
2. настройки через setup CLI до первого refresh;
3. обычного run после активации MCP.

Plugin entry доступен и явной host-командой, и модели по понятному описанию. Renderer full plugin
artifact не выставляет `disable-model-invocation: true` для entry: модель обязана активировать его по
явному пользовательскому запросу «проверь через Bughunter». Ручная репозиторная установка может
сохранять прежнее manual-only поведение. Model invocation проверяется на каждом host, потому что
frontmatter semantics различаются. Никакого фонового или периодического запуска это не разрешает.

### Release tooling

Release tooling расширяется archive sources, SHA256, public repository/homepage metadata и capability
evidence. Он не содержит credentials и не выполняет push. Публикация — отдельное действие после
зелёных gates и подтверждения GitHub owner/auth.

## 6. Пользовательский поток

### 1. Запрос и preflight

Пользователь в корне Git-проекта просит установить Bughunter из GitHub и указывает желаемую цель, если
она уже известна. Агент читает versioned `INSTALL.md`, проверяет Node >=22.18, Git, доступный CLI и
Chrome для web. Версия CLI сохраняется в отчёте, но далее работает capability probe.

Если системной зависимости нет, агент называет её и спрашивает разрешение на установку. Без разрешения
он останавливается с проверяемой командой/инструкцией.

### 2. Установка

Агент выбирает full-артефакт, добавляет/обновляет собственный marketplace, устанавливает и включает
плагин/расширение в user scope. Повторный запуск идемпотентен: существующий marketplace обновляется,
а не дублируется; уже установленная та же версия не переустанавливается без необходимости.

Агент получает `installPath` нативной командой list. Ручной Bughunter MCP server в `.mcp.json` или вторая
конфликтующая установка обнаруживаются до run. Агент не удаляет их молча; предлагает оставить одну
установку и спрашивает подтверждение на изменение.

`mcp__bughunter__*` или фактический host prefix добавляется в permissions точечно. Существующие allow,
deny и остальные settings сохраняются. Если host использует другой permission mechanism, применяется
он; Qwen-specific JSON не копируется в GigaCode без capability evidence.

### 3. Вопросы и конфигурация до refresh

Агент сначала исследует проект и использует сведения исходного запроса. Спрашиваются только отсутствующие
решения:

- preset `web` или `node`;
- URL уже запущенного стенда, если его нельзя подтвердить из проекта;
- первая цель `target <path>`; если пользователь явно просил `diff`, `full` или `sweep`, вопрос не
  повторяется;
- разрешённые origins и маршруты, если предложенный агентом список требует подтверждения;
- нужна ли авторизация;
- разрешены ли state-changing actions и какие запрещённые действия добавить;
- для node — profile, ожидаемые scenarios и безопасный reset; агент не выдумывает reset для реального
  стенда.

Для первого прогона по умолчанию предлагается узкий `target`, а не дорогой `full`. `full`, небезопасный
reset и изменение readOnly требуют явного выбора.

Агент запускает setup CLI create, затем своими файловыми инструментами заполняет config/profiles и
запускает setup CLI validate. Ошибки схемы исправляются до успешной валидации. Существующие валидные
настройки не перезапрашиваются и не перезаписываются. Ни config, ни chat не получают пароли или session
secrets.

### 4. Один refresh и продолжение

В certified Qwen plugins flow настройка завершена до `/plugins reload`, поэтому второй reload для
активации пресета не нужен. Пользователь выполняет `/plugins reload` и отправляет «продолжай»; это
единственное техническое действие пользователя, помимо ответов на вопросы и интерактивного login.

Для extension/GigaCode surface используется фактически проверенная refresh команда. Если там достаточно
hot reload, агент не просит лишний `/plugins reload`; если требуется рестарт, это явно документируется
для surface и не выдаётся за одинаковое поведение с Qwen plugins.

### 5. Проверка и запуск

После refresh агент проверяет:

- enabled/loaded artifact;
- MCP connected;
- project root указывает на целевой проект, а не plugin cache;
- активны ожидаемые 19 web или 16 node tools;
- entry и native agents видны;
- config validation успешна.

Для защищённого web-стенда агент запускает поставляемый headed auth flow с правильным host state.
Пользователь входит в Chrome сам; credentials в чат не запрашиваются. Auth state не попадает в plugin
cache или Git.

Затем агент вызывает Bughunter с выбранной областью. Прогон следует существующим правилам очереди,
lease, reproduce/review/export/verify/finish. По прерыванию агент предлагает `resume <runId>` того же
host state, не создавая новый run и не повторяя завершённых кандидатов.

### 6. Обновление и удаление

Update использует нативный marketplace/extension update выбранного surface и проверяется sentinel-файлами:
opt-in, config, profiles, known/suppressions, runs и auth сохраняются. Uninstall не удаляет project state
автоматически; документация перечисляет оставшиеся host-specific файлы.

## 7. Целостность архива и SHA256

SHA256 — контрольная сумма ZIP, не Git commit SHA и не цифровая подпись.

Marketplace хранит ожидаемый SHA256. После скачивания фактический digest обязан совпасть, иначе архив
повреждён, заменён или не соответствует проверенному релизу и не должен запускаться. Это связывает
catalog entry с конкретными байтами, предотвращает случайную подмену asset при неизменной версии и
позволяет воспроизвести проверку.

Поле `sha256` может быть optional в спецификации хоста, но обязательно по политике Bughunter для remote
archive. Если клиент сам не проверяет digest, установщик агента скачивает архив, проверяет его средствами
Node и только затем передаёт распакованный каталог нативной установке. Нельзя пропустить проверку ради
совместимости.

SHA256 не доказывает авторство: контролирующий одновременно catalog и archive может заменить оба.
HTTPS и GitHub access control остаются отдельными механизмами; signing/provenance attestation может быть
добавлен позднее, но не заявляется в этом этапе.

## 8. Ошибки и безопасность

- Повреждённый opt-in/config не перезаписывается; возвращаются путь и конкретная schema/parse error.
- Setup до явного выбора пресета ничего не создаёт; validate и capability probe не создают state.
- MCP, обнаруживший plugin root вместо project root и не имеющий надёжного workspace signal, возвращает
  `BUGHUNTER_PROJECT_UNKNOWN` до любой записи.
- Checksum mismatch, неизвестный artifact source и отсутствие full components блокируют установку.
- Отсутствие Git/Node/Chrome не изображается как готовность. Системные изменения требуют подтверждения.
- Существующие settings и project files не заменяются целиком; записи атомарны и ограничены Bughunter.
- Origin allowlist, forbidden actions, readOnly, lease, replay budgets и test verdict deadlines не
  ослабляются ради автономного setup или нового CLI.
- `full`, state-changing actions и reset не выбираются моделью молча.
- Не используются `curl | sh`, `--dangerously-skip-permissions`, отключение TLS verification или глобальный
  wildcard permissions ради успешной установки.
- В GitHub не попадают runs, auth, credentials, локальные evidence с чувствительными данными,
  `plugin/dist/`, `plugin/release/` и временные gate-деревья.
- Build и release не выполняют push. Публикация требует явного действия с фактическим owner и настроенной
  GitHub-аутентификацией.

## 9. Проверка

### Общие и unit/integration gates

1. Существующие core/web/node tests и typechecks, CLI template, node acceptance, plugin и release/matrix
   suites проходят без ослабления старых assertions.
2. Setup CLI покрывает web/node create, print, validate, повторный create, no-overwrite, повреждённый JSON,
   невалидную схему, отсутствие profile и нулевые writes у validate.
3. Capability parser/probe покрывает Qwen plugins, Qwen extensions, GigaCode extensions, неизвестный форк,
   отсутствие agents и невозможность определить workspace. Моки проверяют только адаптер; runtime support
   ими не сертифицируется.
4. Artifact tests проверяют manifest, tool vocabulary, namespace, paths, полный набор components и
   отсутствие чужих host paths/placeholders.
5. Release tests проверяют version, payloadCommit/catalogCommit, HTTPS archive, SHA256, license/notices,
   support evidence и запрет локальных путей в публичном catalog.
6. Negative install gate доказывает отказ при однобайтовом изменении ZIP без обновления SHA256.

### Нативные runtime gates до публикации

1. Qwen `1.0.0-preview.1` выполняет strict validation и установку из marketplace archive-source.
2. Dormant не создаёт state; setup CLI + config validation + один `/plugins reload` дают активный набор
   tools без второго reload.
3. Install/update/list/enable и MCP handshake проходят в изолированном config. Sentinel config/profiles/
   runs/auth сохраняются после update.
4. Qwen extensions получает отдельный артефакт только после реальных full component/workspace gates.
5. GigaCode устанавливается и проверяется на настоящем GigaCode CLI. До этого его статус `planned`, а не
   `experimental` или `full`; отсутствие runtime фиксируется как отсутствие evidence, а не PASS.
6. Ни один новый surface не получает `full` только из manifest validation или MCP connected.

### Модельные end-to-end gates

С отдельным разрешением пользователя и только на локальных фикстурах `127.0.0.1`:

1. Свежая Qwen-сессия получает естественную просьбу установить Bughunter по GitHub path и проверить
   известную web-фикстуру.
2. Агент сам выполняет install/setup/validation, задаёт только необходимые вопросы и останавливается ровно
   для одного `/plugins reload`; ручного JSON editing нет.
3. После «продолжай» запускается `target`, известный кандидат воспроизводится и подтверждается, красный
   тест получает независимый red verdict, приложение не изменяется кроме разрешённых tests/config/state.
4. Отдельный gate реально прерывает run и проверяет resume без повторной обработки завершённых
   кандидатов.
5. Node setup получает собственный model target gate с валидным profile/reset локальной фикстуры.
6. GigaCode повторяет install/setup/target на своём реальном CLI до заявления full workflow. Логи и runId
   привязываются к payloadCommit.

### Публичный gate после публикации

В изолированном Qwen config агент повторяет установку из фактического публичного GitHub owner/repo,
release archive и marketplace catalog. Проверяются SHA256, version, MCP и сохранение state после update.
Локальный path или локальный marketplace не засчитываются как этот gate. Если публикация не выполнена,
публичный сценарий остаётся невыполненным, а не «проверенным по аналогии».

## 10. Документация

Публичные README/INSTALL содержат:

- один короткий natural-language сценарий для агента;
- фактические Qwen plugins и поддержанные extension/GigaCode команды;
- prerequisites и безопасные defaults;
- различие custom marketplace и official listing;
- один Qwen refresh и отсутствие ручного JSON editing;
- список вопросов setup и browser-only login;
- state paths, update/uninstall и resume;
- текущий support matrix со статусами planned/experimental/full/blocked;
- ограничения integrity SHA256: это не подпись;
- license и third-party notices.

Исторические handoff/reports не переписываются. До публикации документы не содержат выдуманных owner,
release URLs или утверждения «available on GitHub».

## 11. Критерии завершения

Этап считается завершённым для Qwen plugins, когда:

- публичный GitHub repo и versioned release действительно доступны;
- MIT License и notices присутствуют;
- пользователь даёт GitHub path и цель, а агент сам выполняет install/setup/validate/run;
- единственное техническое действие пользователя — один `/plugins reload`, плюс ответы и login при
  необходимости;
- public install, checksum, update/state preservation, model target и resume gates имеют evidence;
- support matrix и docs совпадают с фактами.

Qwen extensions и GigaCode получают собственные критерии завершения через соответствующие runtime/model
gates. Непроверенный GigaCode не блокирует честный Qwen release, но остаётся `planned` и не рекламируется
как работающий. Официальный marketplace listing не является критерием этого этапа.

## 12. Источники

- Qwen Code Extensions: <https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/>
- Claude marketplace reference для archive/source semantics, требующей отдельной проверки в Qwen:
  <https://code.claude.com/docs/en/plugins/marketplace-reference>
- GigaCode skills: <https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/skills>
- GigaCode subagents: <https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/subagents>
- GigaCode commands: <https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/commands>

## 13. Git-границы дизайна

Коммит этого этапа содержит только данный spec. Существующий untracked
`docs/superpowers/plans/2026-11-17-docs-c1-c20.md` не добавляется. Spec не разрешает реализацию, push,
публикацию, системную установку GigaCode или модельные прогоны без следующих явных шагов и разрешений.
