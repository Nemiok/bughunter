import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { loadConfig } from './config.ts';
import { defaultStateDir } from './paths.ts';

const stateDir = process.env.BUGHUNTER_STATE_DIR === undefined
  ? defaultStateDir
  : resolve(process.env.BUGHUNTER_STATE_DIR);
export const authStorageStatePath = join(stateDir, 'auth', 'storage-state.json');
export const authLaunchOptions = { channel: 'chrome', headless: false } as const;

export async function runAuth(): Promise<void> {
  const config = await loadConfig(stateDir);
  const browser = await chromium.launch(authLaunchOptions);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
    const answer = createInterface({ input: process.stdin, output: process.stderr });
    try {
      await answer.question('Войдите в открытом Chrome, затем нажмите Enter здесь…');
      await mkdir(dirname(authStorageStatePath), { recursive: true });
      await context.storageState({ path: authStorageStatePath });
    } finally {
      answer.close();
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAuth().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
