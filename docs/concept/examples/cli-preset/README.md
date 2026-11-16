# `cli-preset` — учебный пресет, собранный приёмкой гайдлайнов

Это артефакт приёмки §6.8 (задача 13 плана фазы B), а не поддерживаемый пресет: в `presets/` он
не входит. Его собрал свежий агент по поставляемым скиллам и примерам, не видя переписки авторов.

**Измеренный результат** (2026-11-16): модельный прогон `finished`, очередь 9/9, `Pending: None`,
**3 из 4** засеянных багов подтверждены (C1, C2, C4), **0** подтверждённых ложных срабатываний,
4 красных теста перепроверены независимым запуском. C3 (повторный `add`) — измеренный пропуск.
Разбор гайдлайнов и ограничения — `docs/superpowers/reports/2026-11-16-guidelines-acceptance.md`.

## Состав

- `preset/` — пресет: 24 модуля `src/`, 11 тестов, три агента, карта пресета, `state/config.json`
  и профиль приложения.
- `cli-app/` — мини-фикстура: CLI учёта заказов, реестр засеянных багов `SEEDED.md` (C1–C4 и
  контрольная команда).

## Как запустить

1. `preset/` положить в дерево инструмента как `presets/cli`, добавить `"presets/cli"` в
   `workspaces` корневого `package.json`, выполнить `npm install` (core придёт workspace-симлинком).
2. `.mcp.json` проекта:
   `{"mcpServers":{"bughunter":{"command":"node","args":["presets/cli/src/index.ts"]}}}`.
3. Агентов и карту поставить туда, откуда их читает CLI: `preset/agents/*.md` → `.qwen/agents/`,
   `preset/skills/preset-card/SKILL.md` → `.qwen/skills/bughunter-preset-card/SKILL.md`.
4. Каталог `cli-app/` положить в корень проекта: `state/config.json` ссылается на него
   относительно корня (`"appDir": "cli-app"`).
5. Проверка: `cd presets/cli && npm test` (35/35), затем stdio-рукопожатие
   (`initialize` → `tools/list`, 16 инструментов) и прогон `/bughunter full`.

Сгенерированные прогоном тесты в пример не входят: они содержали абсолютные пути временной
копии. Они сохранены в `bughunter-gate/guidelines-attempt-2/cli-app/test/bughunter/` (git-ignored).
