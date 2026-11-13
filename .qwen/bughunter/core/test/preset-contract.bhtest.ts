import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertPreset, assertSinglePreset } from '../src/preset.ts';
import type { Preset } from '../src/preset.ts';

const unused = (): never => {
  throw new Error('не используется в этом тесте');
};

function stubPreset(name = 'stub'): Preset {
  return {
    name,
    configSchema: {},
    inventory: { list: unused, templateOf: unused },
    session: { open: unused },
    snapshot: { compact: unused },
    detectors: { kinds: [], scan: unused },
    checks: { kinds: [], validate: unused, violated: unused },
    replay: { replay: unused },
    generateTest: { generate: unused },
    profile: { load: unused, testDataFile: unused },
    testRunner: { detect: unused, command: unused, parseReport: unused, ownsProject: unused, kinds: [] },
    personas: { roster: [], brief: unused },
    findingKinds: { kinds: [], syntheticStep: unused },
    sweepVisit: { visit: unused },
    reset: { supported: false, apply: unused },
    exportTarget: { dir: unused, kind: 'test', fileName: unused },
    errors: { codes: {} },
    report: { finding: unused, candidate: unused },
  };
}

test('assertPreset accepts a preset implementing all sixteen interfaces', () => {
  const preset = stubPreset();
  assert.equal(assertPreset(preset), preset);
});

test('assertPreset rejects a preset without a required hook', () => {
  const broken = { ...stubPreset(), testRunner: undefined } as unknown;
  assert.throws(() => assertPreset(broken), /PRESET_INVALID: testRunner/);
  assert.throws(() => assertPreset(null), /PRESET_INVALID: preset/);
  assert.throws(() => assertPreset({ ...stubPreset(), name: undefined }), /PRESET_INVALID: name/);
});

test('assertSinglePreset records the preset and rejects a second one', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-preset-'));
  await assertSinglePreset(stateDir, 'web');
  assert.equal(JSON.parse(await readFile(join(stateDir, 'preset.json'), 'utf8')).name, 'web');
  await assertSinglePreset(stateDir, 'web');
  await assert.rejects(() => assertSinglePreset(stateDir, 'node'), /PRESET_CONFLICT/);
});
