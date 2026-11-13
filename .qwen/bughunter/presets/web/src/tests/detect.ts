import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

type Framework = 'jest' | 'vitest';
type PackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

type DetectedProject = {
  root: string;
  packageJson: PackageJson;
};

const configs: Record<Framework, string[]> = {
  jest: [
    'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
    'jest.config.ts', 'jest.config.cts', 'jest.config.mts', 'jest.config.json',
  ],
  vitest: [
    'vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs',
    'vitest.config.ts', 'vitest.config.cts', 'vitest.config.mts',
    'vite.config.js', 'vite.config.cjs', 'vite.config.mjs',
    'vite.config.ts', 'vite.config.cts', 'vite.config.mts',
  ],
};

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function nearestPackage(inputPath: string): Promise<DetectedProject | null> {
  let directory = dirname(resolve(inputPath));
  const filesystemRoot = parse(directory).root;
  while (true) {
    const packagePath = join(directory, 'package.json');
    if (await fileExists(packagePath)) {
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as PackageJson;
      return { root: directory, packageJson };
    }
    if (directory === filesystemRoot) return null;
    directory = dirname(directory);
  }
}

function hasDependency(packageJson: PackageJson, framework: Framework): boolean {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].some((dependencies) => dependencies?.[framework] !== undefined);
}

async function configFramework(start: string, root: string): Promise<Framework | null> {
  let directory = start;
  while (true) {
    for (const framework of ['jest', 'vitest'] as const) {
      for (const config of configs[framework]) {
        if (await fileExists(join(directory, config))) return framework;
      }
    }
    if (directory === root) return null;
    directory = dirname(directory);
  }
}

async function detectFramework(project: DetectedProject, inputPath: string): Promise<Framework | null> {
  const dependencyFrameworks = (['jest', 'vitest'] as const)
    .filter((framework) => hasDependency(project.packageJson, framework));
  if (dependencyFrameworks.length === 1) return dependencyFrameworks[0];
  if ('jest' in project.packageJson) return 'jest';
  return configFramework(dirname(resolve(inputPath)), project.root);
}

async function neighboringTests(root: string, inputPath: string): Promise<string[]> {
  const target = resolve(inputPath);
  const targetDirectory = dirname(target);
  const candidates: Array<{ path: string; example: string; distance: number }> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') await visit(path);
      } else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && resolve(path) !== target) {
        const directoryRelativePath = relative(targetDirectory, directory);
        candidates.push({
          path,
          example: relative(root, path).split(sep).join('/'),
          distance: directoryRelativePath === '' ? 0 : directoryRelativePath.split(sep).length,
        });
      }
    }
  }

  await visit(root);
  return candidates
    .sort((left, right) => left.distance - right.distance || left.example.localeCompare(right.example))
    .slice(0, 3)
    .map((candidate) => candidate.example);
}

export async function detectTests(
  inputPath: string,
  options?: { unitCommand?: string | null },
): Promise<{ framework: Framework | null; command: string | null; examples: string[] }> {
  const project = await nearestPackage(inputPath);
  if (!project) return { framework: null, command: options?.unitCommand ?? null, examples: [] };
  const framework = await detectFramework(project, inputPath);
  if (!framework) return { framework: null, command: options?.unitCommand ?? null, examples: [] };
  const command = options?.unitCommand ?? (framework === 'jest' ? 'npm exec -- jest' : 'npm exec -- vitest run');
  return { framework, command, examples: await neighboringTests(project.root, inputPath) };
}
