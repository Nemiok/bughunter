Если `<optIn>` отсутствует, не вызывай рабочие MCP tools и не проси пользователя редактировать JSON. До `<reload>` используй native Read/Grep/Bash/Write/Edit и native interaction mechanism.

Спроси только недостающие решения: preset web/node, URL запущенного стенда, первая target-область, auth, state-changing permissions; для node — profile/scenarios/reset. Не выбирай full или небезопасный reset молча. Не запрашивай пароли в чате.

Получи installPath через нативный plugin list --json. После явного выбора пресета выполни ровно один create:
`node "$INSTALL_PATH/server/setup-cli.mjs" --action create --project-root "$PWD" --preset "$PRESET"`.

Заполни созданный config и необходимые profiles через native file tools. Сохрани существующие значения. Затем выполни:
`node "$INSTALL_PATH/server/setup-cli.mjs" --action validate --project-root "$PWD" --preset "$PRESET"`.

При CONFIG_INVALID, PROFILE_NOT_FOUND, SETUP_OPT_IN_INVALID или SETUP_PRESET_CONFLICT исправь только собственные setup-файлы либо спроси недостающее решение; не перезаписывай чужие файлы. После SETUP_VALID попроси ровно один `<reload>` и «продолжай». После refresh проверь project root, MCP, 19 web или 16 node tools и native agents. Затем продолжи выбранный scope из `$ARGUMENTS`. Если пользователь уже дал target, используй его; иначе предложи узкий target вместо full.
