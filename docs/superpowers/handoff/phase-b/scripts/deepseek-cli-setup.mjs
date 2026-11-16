// Подключение DeepSeek к Qwen Code CLI без правки пользовательского ~/.qwen/settings.json.
// Ключ читается из файла (по умолчанию ~/.deepseek-key), в репозиторий и в чат не попадает.
// Использование: node setup.mjs [путь-к-ключу]
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const keyFile = process.argv[2] ?? join(homedir(), '.deepseek-key');
if (!existsSync(keyFile)) {
  console.error(`нет файла с ключом: ${keyFile}`);
  console.error('положи ключ одной строкой: printf \'%s\' \'sk-...\' > ~/.deepseek-key && chmod 600 ~/.deepseek-key');
  process.exit(1);
}

const apiKey = readFileSync(keyFile, 'utf8').trim();
if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
  console.error(`ключ не похож на DeepSeek API key: длина ${apiKey.length}, префикс "${apiKey.slice(0, 3)}"`);
  process.exit(1);
}

const userSettingsPath = join(homedir(), '.qwen', 'settings.json');
const user = JSON.parse(readFileSync(userSettingsPath, 'utf8'));

const settings = {
  providers: {
    deepseek: {
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey,
      displayName: 'DeepSeek',
      models: [
        { model: 'deepseek-chat', displayName: 'DeepSeek Chat', contextWindow: 128000 },
        { model: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', contextWindow: 128000 },
      ],
    },
  },
  model: { name: 'deepseek/deepseek-chat' },
  // Переносим только то, что нужно проекту копии: разрешение MCP-сервера по имени и доверие
  // каталогам гейта. Свои ключи и подписка Qwen в отдельный конфиг не попадают.
  mcp: user.mcp ?? { disabledProjectMcpServers: [], enabledProjectMcpServers: ['bughunter'] },
  permissions: {
    trustDirectories: [
      '/Users/nemiok/Desktop/projects/vault/bughunter-phase-b/bughunter-gate/guidelines-check/project',
    ],
  },
};

const dir = join(homedir(), '.qwen-deepseek');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const out = join(dir, 'settings.json');
writeFileSync(out, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
chmodSync(out, 0o600);

console.log(`config: ${out} (mode 600, вне репозитория)`);
console.log(`provider: deepseek → https://api.deepseek.com/v1`);
console.log(`model: ${settings.model.name}`);
console.log(`key: длина ${apiKey.length}, префикс "${apiKey.slice(0, 3)}…" (значение не печатается)`);
