# Qwen Explicit Restart After Setup — Design

## 1. Контекст

Bughunter `0.2.3` опубликован как experimental prerelease. Payload commit `242d884` содержит исправления
завершения runs, явных red verdicts и оркестрации, но model workflow на этом payload не сертифицирован.

Runtime-расследование Qwen Code CLI `1.0.0-preview.2` показало:

- новая Qwen-сессия после setup загружает активный набор web tools;
- dormant-сессия после setup и `/plugins reload` продолжает получать только `bh_setup`;
- после `/plugins reload` отсутствует новый `mcp_context.refresh`;
- `/plugins reload` не является подтверждённым способом активировать изменённый MCP toolset в текущем
  процессе этой версии Qwen.

Исходный spec `2026-11-18-github-qwen-gigacode-autonomous-install-design.md` требует один same-session
reload. Этот документ заменяет данное требование для Qwen plugins на один явный перезапуск. Исторические
specs, plans, handoff/reports и уже опубликованные releases не переписываются.

## 2. Цель и границы

### Цель

Пользователь даёт агенту GitHub repo и цель. Агент сам выполняет install/setup/validate, после чего
пользователь явно перезапускает Qwen и отправляет «продолжай». В новой сессии агент проверяет активные
components и запускает выбранный `target`.

В рамках одного установочного сценария единственное техническое действие пользователя — один перезапуск
после первичного setup, помимо ответов на необходимые вопросы и browser-only login. Независимые
web/node/resume certification scenarios не добавляют лишних перезапусков внутри одного сценария. Ручное
редактирование JSON и `/plugins reload` не требуются.

### Не входит

- Исправление Qwen или реализация собственного MCP refresh protocol.
- Заявление, что same-session reload работает в `1.0.0-preview.2`.
- Автоматический перезапуск пользовательского desktop/CLI процесса агентом.
- Изменение tags/assets `0.2.1`, `0.2.2` или `0.2.3`.
- Official marketplace submission.
- Сертификация Qwen extensions, GigaCode, Kimi или Claude этим потоком.

## 3. Пользовательский поток

### Сессия A: установка и настройка

1. Агент проверяет prerequisites и capabilities; версия Qwen сама по себе не является veto.
2. Агент устанавливает плагин из фактического GitHub custom marketplace и проверяет enabled/version.
3. Агент задаёт только необходимые вопросы, выполняет setup CLI create и заполняет config/profiles своими
   файловыми инструментами без перезаписи существующих валидных настроек.
4. Агент запускает setup CLI validate и устраняет ошибки схемы до успешного результата.
5. Агент фиксирует session ID, project root, isolated config identity, clientVersion, payloadCommit и
   fingerprint config/profiles/scenarios. Runs, auth, journals и logs не входят в этот fingerprint.
6. Агент явно просит перезапустить Qwen в том же project/config и после запуска написать «продолжай».
   Он не просит `/plugins reload` и не начинает target в dormant-сессии.

### Действие пользователя

Пользователь завершает текущий Qwen process и запускает новый в том же project working directory с тем же
config. Затем отправляет «продолжай». Агент не должен представлять это как same-session reload.

### Сессия B: активация и запуск

1. Получен новый `system/init` и новый session ID.
2. Агент подтверждает тот же project/config, plugin version, payloadCommit и clientVersion.
3. Fingerprint config/profiles/scenarios совпадает с состоянием после validate.
4. Host evidence показывает активный набор выбранного preset: для web 19 tools, 7 skills и 6 agents.
   Одного наличия `system/init` или успешного вызова одного MCP tool недостаточно.
5. Только после этого агент запускает `target`. Для сертификации web target используется `/orders/new`.
6. Отдельный node-target доказывает собственный node profile и активный набор 16 tools; он не заменяет
   web activation.

Если после перезапуска доступен только `bh_setup`, activation failed. Нельзя скрытно открыть третью
сессию, запустить target без activation или записать PASS по аналогии.

## 4. Компоненты

- `plugin/test/record-activation-evidence.mjs` — единственный writer sanitized activation evidence.
  Читает первичные artifacts, сравнивает sessions/project/config и получает фактические versions/tool counts.
- `plugin/test/transcript-evidence.mjs` — извлечение host/session/tool events из Qwen JSONL. Model
  orchestration checks остаются отдельными от activation checks.
- `plugin/support-matrix.mjs` — добавляет обязательный Qwen CLI gate `activation`; убирает зависимость
  web target от `reloadVerified`.
- `plugin/test/activation-evidence.test.mjs` и `plugin/test/support-matrix.test.mjs` — positive contract и
  отдельные negative regressions.
- `plugin/prompts.mjs` и активные setup/entry prompts — запрещают target до successful activation и не
  предлагают неподдерживаемый reload.
- `INSTALL.md`, `README.md`, `plugin/README.md`, `plugin/hosts/qwen.README.md` и упакованные runbooks —
  описывают один явный перезапуск и ограничение Qwen `1.0.0-preview.2`.
- `plugin/evidence/qwen/activation.json` и `bughunter-gate/qwen-restart-0.2.4/**` — ignored runtime
  artifacts, не коммитятся.

Core/presets остаются host-neutral. Существующие strict model recorder, candidate/target ownership,
orchestration и independent red checks не ослабляются.

## 5. Activation evidence contract

Успешный writer создает JSON со следующей формой:

```json
{
  "host": "qwen",
  "surface": "cli",
  "gate": "activation",
  "status": "passed",
  "sourceCommit": "<40 lowercase hex payload commit>",
  "clientVersion": "<actual qwen --version>",
  "pluginVersion": "<actual installed version>",
  "activationMode": "new-session",
  "setupValidated": true,
  "restartVerified": true,
  "newSessionVerified": true,
  "sameProjectVerified": true,
  "configPreserved": true,
  "continuationVerified": true,
  "activeToolsVerified": true,
  "preset": "web",
  "toolCount": 19,
  "skillCount": 7,
  "agentCount": 6,
  "transcriptSha256": ["<before SHA256>", "<after SHA256>"]
}
```

Это иллюстративный schema, а не runtime evidence. Writer обязан получить значения из фактических
artifacts. Поля, перечисленные как `true`, нельзя принимать от caller без проверки.

Writer проверяет два ordered transcripts и host/runtime artifacts:

1. Before transcript содержит успешные install/setup/validate и отсутствие target до restart.
2. Session IDs различны; after transcript начинается с нового init до продолжения.
3. Project root и config identity совпадают. Absolute paths сравниваются в памяти, но не записываются в
   sanitized evidence.
4. Post-validate config fingerprint совпадает до запуска target. Изменение config отклоняется.
5. Пользовательское «продолжай» предшествует tool inventory и `bh_start_run`.
6. Tool inventory получен из host-native events/output, а не только из caller-supplied JSON.
7. `sourceCommit` совпадает с validated public-install evidence и фактическим installed payload;
   clientVersion получен из фактического Qwen process и совпадает с остальными gates.
8. SHA256 вычисляется по обоим полным transcript files. Сами transcripts, auth и secrets в evidence не
   включаются.

При любой ошибке activation evidence не создаётся и не перезаписывается. Старые `reloadVerified` fixtures
не эквивалентны новому gate.

## 6. Support matrix и связь с model gates

Qwen CLI `full` требует на одном payloadCommit/clientVersion:

```text
install + public-install + activation + web target + node-target + web resume
```

Matrix принимает activation только при полном schema из раздела 5 и matching host/surface/gate/source/client.
Отсутствие activation оставляет Qwen experimental; текущий stale/blocked/version-conflict порядок не
ослабляется.

Model target/resume больше не доказывают activation через `reloadVerified`. Они продолжают независимо
проверять:

- finished run и все required stages;
- отсутствие pending/false confirmed;
- confirmed candidate внутри заявленного target;
- последовательные explorer leases и native foreground agents;
- отсутствие main restricted tools;
- свежий независимый red runner report.

Web target и web resume используют `/orders/new`; node-target использует маршрут из исходного плана
`GET /orders`. Node-target evidence дополнительно содержит `activeToolsVerified:true`, `preset:"node"` и
`toolCount:16`, полученные из host evidence; matrix проверяет эти поля. Node resume не заменяет web resume.
Model gates не могут компенсировать отсутствующий activation gate.

## 7. Ошибки и безопасность

- Нет нового session ID → `ACTIVATION_RESTART_REQUIRED`.
- Другой project/config → `ACTIVATION_CONTEXT_MISMATCH`.
- Изменился post-setup config → `ACTIVATION_CONFIG_CHANGED`.
- Нет continuation или неверный порядок → `ACTIVATION_CONTINUATION_INVALID`.
- Dormant/неполный toolset → `ACTIVATION_TOOLS_INCOMPLETE`.
- Payload/client mismatch → существующий stale/version-conflict gate, без ручного исправления JSON.
- Любой model/orchestration/red defect → соответствующий gate не записывается, release остаётся
  experimental.

Никаких паролей в чате, auth contents в evidence, secrets в logs/commits или wildcard permissions. Runtime
tests используют только свежие локальные fixtures `127.0.0.1`; production и Навигатор BI запрещены.

## 8. Проверка

### Автоматические tests

1. Positive fixture с двумя валидными session transcripts даёт sanitized activation evidence.
2. Отдельные negative tests: отсутствие validate, same session, другой project/config, config drift,
   missing continuation, missing active tools, wrong counts, payload/client mismatch, malformed transcript.
3. Matrix без activation не даёт full даже при наличии остальных gates и старого `reloadVerified`.
4. Существующие model recorder/transcript/red/public-install suites не ослабляются.
5. Полная стандартная линия core/web/node/template/typechecks/node acceptance/plugin/release/install gates
   проходит на committed payload `0.2.4`.

### Runtime gates

1. Public update `0.2.3 → 0.2.4`: catalog/archive SHA256, enabled version и config/profiles/runs/auth
   sentinels проверены независимым writer.
2. Реальная Qwen activation проходит двухсессионный поток и доказывает active components.
3. Web `/orders/new`, node `GET /orders` и web resume получают strict model evidence на том же
   payload/client.
4. Unit fixtures и mocked spawn не засчитываются как runtime/model gates.

## 9. Документация и выпуск

Следующий payload — `0.2.4`. До model evidence он публикуется как experimental prerelease. Experimental
suffix снимается только после успешной матрицы; ZIP и его SHA256 при catalog/metadata updates не меняются.

Активная документация должна явно сказать: для Qwen `1.0.0-preview.2` после setup требуется перезапуск,
а `/plugins reload` недостаточен. Старые releases и исторические отчёты не переписываются. Если любой gate
не выполнен, release остаётся experimental с конкретными blockers в matrix/COMPATIBILITY и финальном отчёте.

## 10. Definition of Done

- Пользователь не редактирует JSON и не выполняет `/plugins reload`; требуется один явный перезапуск.
- Activation recorder доказывает setup, новый session ID, тот же project/config, continuation и active
  components по первичным artifacts.
- Support matrix не принимает reload-only или caller-declared activation как full.
- Public update и sentinels проверены на `0.2.4`.
- Web target, node target и web resume приняты строгим recorder на одном payload/client.
- Docs и packaged runbooks соответствуют новому потоку.
- Qwen extensions/GigaCode остаются planned без собственных runtime/model evidence.
- Любой непроверенный пункт назван непроверенным; experimental не выдаётся за full.
