import { stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let directory = resolve(start);
  const root = parse(directory).root;
  while (true) {
    if (await pathExists(join(directory, '.git'))) {
      return directory;
    }
    if (directory === root) {
      throw new Error(`PROJECT_ROOT_NOT_FOUND: ${resolve(start)}`);
    }
    directory = dirname(directory);
  }
}
