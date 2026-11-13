import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { detectTests } from '../src/tests/detect.ts';

const jestFixture = resolve(import.meta.dirname, '../../../fixtures/jest-project');
const vitestFixture = resolve(import.meta.dirname, '../../../fixtures/vitest-project');
const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryProject(packageJson: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bh-detect-'));
  temporaryDirectories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');
  return root;
}

async function writeFixtureFile(path: string, source = ''): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf8');
}

test('Jest fixture uses its project-local npm exec command and excludes the target example', async () => {
  assert.deepEqual(await detectTests(join(jestFixture, 'sum.test.js')), {
    framework: 'jest',
    command: 'npm exec -- jest',
    examples: ['broken.test.js', 'green.test.js', 'import.test.js'],
  });
});

test('Vitest fixture uses run mode with its project-local npm exec command', async () => {
  assert.deepEqual(await detectTests(join(vitestFixture, 'sum.test.ts')), {
    framework: 'vitest',
    command: 'npm exec -- vitest run',
    examples: ['broken.test.ts', 'green.test.ts', 'import.test.ts'],
  });
});

test('nearest package.json and config take precedence over an outer project', async () => {
  const root = await temporaryProject({ devDependencies: { jest: '^30.2.0' } });
  await writeFixtureFile(join(root, 'jest.config.js'));
  const nested = join(root, 'packages', 'nested');
  await writeFixtureFile(join(nested, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.2.4' } }));
  await writeFixtureFile(join(nested, 'vitest.config.ts'));

  assert.deepEqual(await detectTests(join(nested, 'src', 'target.test.ts')), {
    framework: 'vitest',
    command: 'npm exec -- vitest run',
    examples: [],
  });
});

test('Jest config variants detect Jest without a framework dependency', async (t) => {
  for (const config of ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.cts', 'jest.config.mts', 'jest.config.json']) {
    await t.test(config, async () => {
      const root = await temporaryProject({});
      await writeFixtureFile(join(root, config));
      const result = await detectTests(join(root, 'target.test.js'));
      assert.equal(result.framework, 'jest');
      assert.equal(result.command, 'npm exec -- jest');
    });
  }
});

test('package.json Jest config detects Jest without a framework dependency', async () => {
  const root = await temporaryProject({ jest: { testEnvironment: 'node' } });
  const result = await detectTests(join(root, 'target.test.js'));
  assert.equal(result.framework, 'jest');
  assert.equal(result.command, 'npm exec -- jest');
});

test('Vitest and Vite config variants detect Vitest without a framework dependency', async (t) => {
  const configs = [
    'vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs',
    'vitest.config.ts', 'vitest.config.cts', 'vitest.config.mts',
    'vite.config.js', 'vite.config.cjs', 'vite.config.mjs',
    'vite.config.ts', 'vite.config.cts', 'vite.config.mts',
  ];
  for (const config of configs) {
    await t.test(config, async () => {
      const root = await temporaryProject({});
      await writeFixtureFile(join(root, config));
      const result = await detectTests(join(root, 'target.test.ts'));
      assert.equal(result.framework, 'vitest');
      assert.equal(result.command, 'npm exec -- vitest run');
    });
  }
});

test('explicit unit command is preserved verbatim and does not include the target path', async () => {
  const unitCommand = 'npm run test:unit -- --custom-reporter';
  const result = await detectTests(join(jestFixture, 'sum.test.js'), { unitCommand });
  assert.equal(result.framework, 'jest');
  assert.equal(result.command, unitCommand);
  assert.ok(!result.command.includes('sum.test.js'));
});

test('unknown nearest framework returns nulls and no examples', async () => {
  const outer = await temporaryProject({ devDependencies: { jest: '^30.2.0' } });
  const root = join(outer, 'packages', 'unknown');
  await writeFixtureFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { mocha: '^11.0.0' } }));
  assert.deepEqual(await detectTests(join(root, 'target.test.js')), {
    framework: null,
    command: null,
    examples: [],
  });
});

test('examples are existing tests only, capped at three and sorted by proximity then name', async () => {
  const root = await temporaryProject({ devDependencies: { jest: '^30.2.0' } });
  const target = join(root, 'src', 'target.test.ts');
  for (const path of [
    target,
    join(root, 'src', 'z.test.ts'),
    join(root, 'root.test.ts'),
    join(root, 'src', 'b', 'two.test.ts'),
    join(root, 'src', 'a', 'two.test.ts'),
    join(root, 'src', 'a', 'one.test.ts'),
    join(root, 'src', 'not-a-test.ts'),
    join(root, 'node_modules', 'package', 'ignored.test.ts'),
  ]) {
    await writeFixtureFile(path);
  }

  assert.deepEqual(await detectTests(target), {
    framework: 'jest',
    command: 'npm exec -- jest',
    examples: ['src/z.test.ts', 'root.test.ts', 'src/a/one.test.ts'],
  });
});
