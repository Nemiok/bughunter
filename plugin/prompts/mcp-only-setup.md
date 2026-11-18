---
name: bughunter-setup
description: Настраивает локальный Bughunter MCP в проекте после явного выбора пресета.
---
Спроси пользователя `web` или `node`. После явного выбора вызови `mcp__bughunter__bh_setup` с `preset`. При `CONFIG_CREATED` покажи configPath и попроси заполнить config, затем выполни `/plugins reload` или открой новую сессию. Не выбирай пресет сам. Не обещай автоматический full workflow, native reviewer/test-writer agents или сертифицированный прогон. Отдельные MCP calls разрешены только в рамках схемы и серверных защит.
