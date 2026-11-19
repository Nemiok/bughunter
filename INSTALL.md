# Bughunter: установка агентом в Qwen

Дайте агенту в корне целевого Git-проекта GitHub owner/repo Bughunter и цель, например: «Установи Bughunter из фактического owner/repo этой страницы и проверь /orders». Не вставляйте примерный owner в реальную команду.

Агент обязан:

1. Сохранить переданный репозиторий в `BUGHUNTER_REPO`, проверив формат `owner/repo`; не читать credentials.
2. Проверить Node >=22.18, Git и Chrome для web. Системную установку выполнять только после разрешения.
3. Выполнить `qwen --version`, `qwen plugins --help` и, при наличии, `qwen extensions --help`. Версия сама по себе не veto. Для Qwen plugins использовать этот поток; для extensions перейти к capability-gated разделу compatibility release.
4. Проверить `qwen plugins marketplace list --json`. Если `bughunter-market` уже существует, выполнить update, иначе:

```sh
qwen plugins marketplace add "$BUGHUNTER_REPO"
```

5. Сначала выполнить `qwen plugins list --json`. Если та же version уже установлена и enabled, пропустить install/enable. Иначе установить user-scope plugin, затем повторить list и выполнить enable только при `enabled !== true`:

```sh
qwen plugins install bughunter@bughunter-market -s user --json
qwen plugins enable bughunter@bughunter-market
qwen plugins list --json
```

6. Не запускать повторный install той же версии и не вызывать enable для уже enabled plugin без проверки list. Не удалять старый `.mcp.json` без подтверждения; при конфликте попросить оставить один Bughunter server.
7. Точечно добавить `mcp__bughunter__*` в `permissions.allow`, сохранив существующие settings.
8. Получить `installPath`, задать только недостающие вопросы и выполнить setup CLI create+validate. Не просить пользователя редактировать JSON. Если клиент не проверяет catalog `sha256` сам, скачать именно catalog URL, вычислить SHA256 средствами Node, сравнить с catalog и только затем распаковать и установить локальный каталог. Игнорировать mismatch нельзя.
9. После успешного validate попросить ровно один явный перезапуск `qwen` в том же project/config, затем «продолжай». Не предлагать `/plugins reload` как замену: на `1.0.0-preview.2` он не обновляет MCP toolset. В новой сессии проверить `/mcp`, project root и 19 web или 16 node components, затем вызвать `/bughunter:bughunter target /orders` либо фактическую цель пользователя.
10. Для auth открыть bundled headed Chrome flow; не спрашивать пароль в чате. Для прерванного run использовать `resume` с фактическим runId.

Custom marketplace не является официальным Qwen listing. SHA256 release archive обязателен; mismatch отклоняется. Статусы поддержки находятся в `COMPATIBILITY.md` выбранного release.
