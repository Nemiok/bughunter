import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

/**
 * Описание одного тестового фреймворка. Таблица принадлежит пресету: core умеет искать
 * ближайший проект, сравнивать зависимости и имена конфигов и подбирать соседние примеры,
 * но не знает ни одного конкретного фреймворка.
 */
export type TestFramework = {
  name: string;
  dependency: string;
  configFiles: string[];
  command: string;
  /** Ключ верхнего уровня `package.json`, который однозначно указывает фреймворк. */
  packageJsonKey?: string;
};

export type PackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
} & Record<string, unknown>;

export type DetectedProject = { root: string; packageJson: PackageJson };

export type DetectOptions = {
  frameworks: TestFramework[];
  /** Как выглядит файл теста в этом стеке: шаблон принадлежит пресету. */
  testFilePattern: RegExp;
  unitCommand?: string | null;
};

export type DetectedTests = { framework: string | null; command: string | null; examples: string[] };

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function nearestPackage(inputPath: string): Promise<DetectedProject | null> {
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

function hasDependency(packageJson: PackageJson, dependency: string): boolean {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].some((dependencies) => dependencies?.[dependency] !== undefined);
}

async function configFramework(start: string, root: string, frameworks: TestFramework[]): Promise<string | null> {
  let directory = start;
  while (true) {
    for (const framework of frameworks) {
      for (const config of framework.configFiles) {
        if (await fileExists(join(directory, config))) return framework.name;
      }
    }
    if (directory === root) return null;
    directory = dirname(directory);
  }
}

async function detectFramework(project: DetectedProject, inputPath: string, frameworks: TestFramework[]): Promise<string | null> {
  const byDependency = frameworks.filter((framework) => hasDependency(project.packageJson, framework.dependency));
  if (byDependency.length === 1) return byDependency[0]!.name;
  const byKey = frameworks.find((framework) => framework.packageJsonKey !== undefined && framework.packageJsonKey in project.packageJson);
  if (byKey !== undefined) return byKey.name;
  return configFramework(dirname(resolve(inputPath)), project.root, frameworks);
}

export async function neighboringTests(root: string, inputPath: string, testFilePattern: RegExp): Promise<string[]> {
  const target = resolve(inputPath);
  const targetDirectory = dirname(target);
  const candidates: Array<{ path: string; example: string; distance: number }> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') await visit(path);
      } else if (entry.isFile() && testFilePattern.test(entry.name) && resolve(path) !== target) {
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

export async function detectTests(inputPath: string, options: DetectOptions): Promise<DetectedTests> {
  const fallback = { framework: null, command: options.unitCommand ?? null, examples: [] };
  const project = await nearestPackage(inputPath);
  if (project === null) return fallback;
  const name = await detectFramework(project, inputPath, options.frameworks);
  const framework = options.frameworks.find((candidate) => candidate.name === name);
  if (framework === undefined) return fallback;
  return {
    framework: framework.name,
    command: options.unitCommand ?? framework.command,
    examples: await neighboringTests(project.root, inputPath, options.testFilePattern),
  };
}
