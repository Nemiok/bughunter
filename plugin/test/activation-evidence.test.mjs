import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  activationWriterFixture,
  BUGHUNTER_AGENTS,
  BUGHUNTER_SKILLS,
  BUGHUNTER_WEB_TOOLS,
  cleanupActivationFixture,
  persistActivationFixture,
  validActivationFixture,
} from './activation-fixture.mjs';
import { createSetupSnapshot, recordActivationGate } from './activation-evidence.mjs';
import { inspectQwenActivation, inspectQwenComponents } from './transcript-evidence.mjs';

function contentBlocks(event) {
  return Array.isArray(event?.message?.content) ? event.message.content : [];
}

function initOf(events) {
  return events.find((event) => event.type === 'system' && event.subtype === 'init');
}

function withoutTool(events, id) {
  return events.filter((event) => !contentBlocks(event).some((block) =>
    block?.id === id || block?.tool_use_id === id));
}

function withoutText(events, pattern) {
  return events.filter((event) => !contentBlocks(event).some((block) =>
    block?.type === 'text' && pattern.test(block.text)));
}

async function withFixture(run) {
  const fixture = await validActivationFixture();
  try {
    await run(fixture);
  } finally {
    await cleanupActivationFixture(fixture);
  }
}

test('inspectQwenComponents counts only Bughunter components from init', async () => {
  await withFixture(async (fixture) => {
    assert.deepEqual(inspectQwenComponents(fixture.beforeInit), {
      toolCount: 1,
      skillCount: 1,
      agentCount: 0,
      mcpConnected: true,
      dormantOnly: true,
    });
    assert.deepEqual(inspectQwenComponents(fixture.afterInit), {
      toolCount: 19,
      skillCount: 7,
      agentCount: 6,
      mcpConnected: true,
      dormantOnly: false,
    });
    assert.throws(() => inspectQwenComponents({}), /TRANSCRIPT_INIT_REQUIRED/);
  });
});

test('valid activation links two sessions with active web components', async () => {
  await withFixture(async (fixture) => {
    assert.deepEqual(await inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), {
      projectRoot: fixture.projectRoot,
      pluginRoot: fixture.pluginRoot,
      restartVerified: true,
      newSessionVerified: true,
      sameProjectVerified: true,
      setupValidated: true,
      continuationVerified: true,
      activeToolsVerified: true,
      toolCount: BUGHUNTER_WEB_TOOLS.length,
      skillCount: BUGHUNTER_SKILLS.length,
      agentCount: BUGHUNTER_AGENTS.length,
    });
  });
});

test('activation rejects missing transcripts', async () => {
  await assert.rejects(inspectQwenActivation({}), /TRANSCRIPT_EMPTY/);
});

test('activation rejects malformed jsonl', async () => {
  await withFixture(async (fixture) => {
    await writeFile(fixture.beforeTranscriptPath, '{not-json}\n', 'utf8');
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /TRANSCRIPT_INVALID/);
  });
});

test('activation rejects the same session id', async () => {
  await withFixture(async (fixture) => {
    const events = structuredClone(fixture.afterEvents);
    initOf(events).session_id = fixture.beforeInit.session_id;
    fixture.afterEvents = events;
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_RESTART_REQUIRED/);
  });
});

test('activation rejects a missing new-session init', async () => {
  await withFixture(async (fixture) => {
    fixture.afterEvents = fixture.afterEvents.filter((event) => event !== fixture.afterInit);
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_RESTART_REQUIRED/);
  });
});

test('activation rejects a different project root', async () => {
  await withFixture(async (fixture) => {
    const events = structuredClone(fixture.afterEvents);
    initOf(events).cwd = `${fixture.projectRoot}-other`;
    fixture.afterEvents = events;
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_CONTEXT_MISMATCH/);
  });
});

test('activation rejects a different plugin root', async () => {
  await withFixture(async (fixture) => {
    const events = structuredClone(fixture.afterEvents);
    initOf(events).plugins[0].path = `${fixture.pluginRoot}-other`;
    fixture.afterEvents = events;
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_CONTEXT_MISMATCH/);
  });
});

test('activation rejects a session without a successful setup validate', async () => {
  await withFixture(async (fixture) => {
    fixture.beforeEvents = withoutTool(fixture.beforeEvents, 'setup-validate');
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_SETUP_REQUIRED/);
  });
});

test('activation rejects setup validate for another project or install', async () => {
  for (const makeReplacement of [
    (fixture) => [fixture.projectRoot, `${fixture.projectRoot}-other`],
    (fixture) => [join(fixture.pluginRoot, 'server', 'setup-cli.mjs'), join(`${fixture.pluginRoot}-other`, 'server', 'setup-cli.mjs')],
  ]) {
    await withFixture(async (fixture) => {
      const [search, replacement] = makeReplacement(fixture);
      fixture.beforeEvents = fixture.beforeEvents.map((event) => {
        const blocks = contentBlocks(event);
        if (!blocks.some((block) => block?.id === 'setup-validate')) return event;
        return {
          ...event,
          message: {
            ...event.message,
            content: blocks.map((block) => block?.id === 'setup-validate'
              ? { ...block, input: { ...block.input, command: block.input.command.replace(search, replacement) } }
              : block),
          },
        };
      });
      await persistActivationFixture(fixture);
      await assert.rejects(inspectQwenActivation({
        beforeTranscriptPath: fixture.beforeTranscriptPath,
        afterTranscriptPath: fixture.afterTranscriptPath,
      }), /ACTIVATION_SETUP_REQUIRED/);
    });
  }
});

test('activation rejects a failed setup validate result', async () => {
  await withFixture(async (fixture) => {
    fixture.beforeEvents = fixture.beforeEvents.map((event) => {
      const blocks = contentBlocks(event);
      if (!blocks.some((block) => block?.tool_use_id === 'setup-validate')) return event;
      return {
        ...event,
        message: {
          ...event.message,
          content: blocks.map((block) => block?.tool_use_id === 'setup-validate'
            ? { ...block, content: JSON.stringify({ code: 'CONFIG_INVALID' }) }
            : block),
        },
      };
    });
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_SETUP_FAILED/);
  });
});

test('activation rejects a missing continuation', async () => {
  await withFixture(async (fixture) => {
    fixture.afterEvents = withoutText(fixture.afterEvents, /продолжай/i);
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_CONTINUATION_INVALID/);
  });
});

test('activation rejects continuation before the new init', async () => {
  await withFixture(async (fixture) => {
    const continuation = fixture.afterEvents.find((event) => contentBlocks(event)
      .some((block) => block?.type === 'text' && /продолжай/i.test(block.text)));
    fixture.afterEvents = [continuation, ...fixture.afterEvents.filter((event) => event !== continuation)];
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_CONTINUATION_INVALID/);
  });
});

test('activation requires an inventory check after continuation', async () => {
  await withFixture(async (fixture) => {
    fixture.afterEvents = withoutTool(fixture.afterEvents, 'activation-inventory');
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_INVENTORY_REQUIRED/);
  });
});

test('activation rejects a dormant session after restart', async () => {
  await withFixture(async (fixture) => {
    const events = structuredClone(fixture.afterEvents);
    const init = initOf(events);
    init.tools = ['Bash', 'Read', 'Write', 'mcp__bughunter__bh_setup'];
    init.skills = ['bughunter'];
    init.agents = [];
    fixture.afterEvents = events;
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_TOOLS_INCOMPLETE/);
  });
});

for (const count of [18, 20]) {
  test(`activation rejects ${count} Bughunter tools`, async () => {
    await withFixture(async (fixture) => {
      const events = structuredClone(fixture.afterEvents);
      const init = initOf(events);
      const tools = count === 18 ? BUGHUNTER_WEB_TOOLS.slice(0, 18) : [...BUGHUNTER_WEB_TOOLS, 'mcp__bughunter__bh_extra'];
      init.tools = ['Bash', 'Read', 'Write', ...tools];
      fixture.afterEvents = events;
      await persistActivationFixture(fixture);
      await assert.rejects(inspectQwenActivation({
        beforeTranscriptPath: fixture.beforeTranscriptPath,
        afterTranscriptPath: fixture.afterTranscriptPath,
      }), /ACTIVATION_TOOLS_INCOMPLETE/);
    });
  });
}

test('activation rejects six skills and five agents', async () => {
  for (const [key, value] of [['skills', BUGHUNTER_SKILLS.slice(0, 6)], ['agents', BUGHUNTER_AGENTS.slice(0, 5)]]) {
    await withFixture(async (fixture) => {
      const events = structuredClone(fixture.afterEvents);
      initOf(events)[key] = value;
      fixture.afterEvents = events;
      await persistActivationFixture(fixture);
      await assert.rejects(inspectQwenActivation({
        beforeTranscriptPath: fixture.beforeTranscriptPath,
        afterTranscriptPath: fixture.afterTranscriptPath,
      }), /ACTIVATION_TOOLS_INCOMPLETE/);
    });
  }
});

test('activation rejects a disconnected Bughunter MCP server', async () => {
  await withFixture(async (fixture) => {
    const events = structuredClone(fixture.afterEvents);
    initOf(events).mcp_servers = [{ name: 'bughunter', status: 'disconnected' }];
    fixture.afterEvents = events;
    await persistActivationFixture(fixture);
    await assert.rejects(inspectQwenActivation({
      beforeTranscriptPath: fixture.beforeTranscriptPath,
      afterTranscriptPath: fixture.afterTranscriptPath,
    }), /ACTIVATION_TOOLS_INCOMPLETE/);
  });
});

for (const side of ['before', 'after']) {
  test(`activation rejects bh_start_run in the ${side} transcript`, async () => {
    await withFixture(async (fixture) => {
      const key = `${side}Events`;
      const events = structuredClone(fixture[key]);
      events.push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: `start-${side}`,
            name: 'mcp__bughunter__bh_start_run',
            input: { scope: 'target', target: '/orders/new' },
          }],
        },
      });
      fixture[key] = events;
      await persistActivationFixture(fixture);
      await assert.rejects(inspectQwenActivation({
        beforeTranscriptPath: fixture.beforeTranscriptPath,
        afterTranscriptPath: fixture.afterTranscriptPath,
      }), /ACTIVATION_TARGET_TOO_EARLY/);
    });
  });
}

const CONFIG_KEY = '.qwen/bughunter/state/web/config.json';

async function snapshotsFor(fixture) {
  return {
    beforeSnapshot: await createSetupSnapshot({ projectRoot: fixture.projectRoot, preset: 'web' }),
    afterSnapshot: await createSetupSnapshot({ projectRoot: fixture.projectRoot, preset: 'web' }),
  };
}

async function writerInput(fixture) {
  return {
    beforeTranscriptPath: fixture.beforeTranscriptPath,
    afterTranscriptPath: fixture.afterTranscriptPath,
    ...await snapshotsFor(fixture),
    publicInstallEvidencePath: fixture.publicInstallEvidencePath,
    installList: fixture.installList,
    configDir: fixture.configDir,
    evidenceDir: fixture.evidenceDir,
    spawn: fixture.spawn,
  };
}

async function writePublicEvidence(fixture, patch) {
  fixture.publicEvidence = { ...fixture.publicEvidence, ...patch };
  await writeFile(fixture.publicInstallEvidencePath, `${JSON.stringify(fixture.publicEvidence, null, 2)}\n`);
}

async function assertWriterRejects(configure, pattern) {
  const fixture = await activationWriterFixture();
  try {
    const input = await writerInput(fixture);
    await configure(fixture, input);
    await assert.rejects(recordActivationGate(input), pattern);
    await assert.rejects(access(join(fixture.evidenceDir, 'qwen', 'activation.json')), /ENOENT/);
  } finally {
    await cleanupActivationFixture(fixture);
  }
}

test('setup snapshot hashes only opt-in, config, profiles and scenarios', async () => {
  const fixture = await validActivationFixture();
  try {
    const snapshot = await createSetupSnapshot({ projectRoot: fixture.projectRoot, preset: 'web' });
    const expectedOptIn = createHash('sha256')
      .update(await readFile(join(fixture.projectRoot, '.qwen', 'bughunter.json')))
      .digest('hex');
    assert.equal(snapshot.projectRoot, resolve(fixture.projectRoot));
    assert.equal(snapshot.files['.qwen/bughunter.json'], expectedOptIn);
    assert.equal(snapshot.files[CONFIG_KEY].length, 64);
    assert.ok(snapshot.files['.qwen/bughunter/state/web/profiles/default.json']);
    assert.ok(snapshot.files['.qwen/bughunter/state/web/scenarios/orders-new.json']);
    assert.deepEqual(Object.keys(snapshot.files), [...Object.keys(snapshot.files)].sort());
    assert.equal(Object.keys(snapshot.files).some((path) => path.startsWith('/')), false);
    assert.equal(JSON.stringify(snapshot.files).includes(fixture.projectRoot), false);
    assert.equal(Object.keys(snapshot.files).some((path) => path.includes('/runs/')), false);
    assert.equal(Object.keys(snapshot.files).some((path) => path.includes('/auth/')), false);
    assert.deepEqual(
      await createSetupSnapshot({ projectRoot: fixture.projectRoot, preset: 'web' }),
      snapshot,
      'snapshot is deterministic',
    );
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test('setup snapshot rejects missing config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-snapshot-missing-'));
  try {
    await mkdir(join(root, '.qwen'), { recursive: true });
    await writeFile(join(root, '.qwen', 'bughunter.json'), '{"preset":"web"}\n');
    await assert.rejects(createSetupSnapshot({ projectRoot: root, preset: 'web' }), /ACTIVATION_SETUP_FILES_REQUIRED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup snapshot rejects symlinked setup files', async () => {
  const fixture = await validActivationFixture();
  try {
    await symlink('default.json', join(fixture.stateDir, 'profiles', 'linked.json'));
    await assert.rejects(
      createSetupSnapshot({ projectRoot: fixture.projectRoot, preset: 'web' }),
      /ACTIVATION_SETUP_SYMLINK/,
    );
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test('setup snapshot requires a nonempty node profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-snapshot-node-'));
  try {
    const stateDir = join(root, '.qwen', 'bughunter', 'state', 'node');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(root, '.qwen', 'bughunter.json'), '{"preset":"node"}\n');
    await writeFile(join(stateDir, 'config.json'), '{"baseUrl":"http://127.0.0.1:4311"}\n');
    await assert.rejects(createSetupSnapshot({ projectRoot: root, preset: 'node' }), /ACTIVATION_SETUP_FILES_REQUIRED/);
    await mkdir(join(stateDir, 'profiles'), { recursive: true });
    await writeFile(join(stateDir, 'profiles', 'default.json'), '{"name":"default"}\n');
    const snapshot = await createSetupSnapshot({ projectRoot: root, preset: 'node' });
    assert.ok(snapshot.files['.qwen/bughunter/state/node/profiles/default.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('activation writer records a sanitized two-session evidence JSON', async () => {
  const fixture = await activationWriterFixture();
  try {
    const input = await writerInput(fixture);
    const path = await recordActivationGate(input);
    assert.equal(path, join(fixture.evidenceDir, 'qwen', 'activation.json'));
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    assertActivationSchema(evidence);
    assert.equal(evidence.sourceCommit, fixture.publicEvidence.sourceCommit);
    assert.equal(evidence.clientVersion, fixture.publicEvidence.clientVersion);
    assert.equal(evidence.pluginVersion, fixture.publicEvidence.updatedTo);
    assert.equal(evidence.activationMode, 'new-session');
    assert.equal(evidence.preset, 'web');
    assert.equal(evidence.toolCount, 19);
    assert.equal(evidence.skillCount, 7);
    assert.equal(evidence.agentCount, 6);
    assert.equal(evidence.transcriptSha256.length, 2);
    const beforeDigest = createHash('sha256').update(await readFile(fixture.beforeTranscriptPath)).digest('hex');
    const afterDigest = createHash('sha256').update(await readFile(fixture.afterTranscriptPath)).digest('hex');
    assert.deepEqual(evidence.transcriptSha256, [beforeDigest, afterDigest]);
    assert.equal(JSON.stringify(evidence).includes(fixture.projectRoot), false);
    assert.equal(JSON.stringify(evidence).includes(fixture.pluginRoot), false);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

function assertActivationSchema(evidence) {
  const keys = [
    'host', 'surface', 'gate', 'status', 'sourceCommit', 'clientVersion', 'pluginVersion',
    'activationMode', 'setupValidated', 'restartVerified', 'newSessionVerified',
    'sameProjectVerified', 'configPreserved', 'continuationVerified', 'activeToolsVerified',
    'preset', 'toolCount', 'skillCount', 'agentCount', 'transcriptSha256',
  ].sort();
  assert.deepEqual(Object.keys(evidence).sort(), keys);
  assert.equal(evidence.host, 'qwen');
  assert.equal(evidence.surface, 'cli');
  assert.equal(evidence.gate, 'activation');
  assert.equal(evidence.status, 'passed');
  for (const key of [
    'setupValidated', 'restartVerified', 'newSessionVerified', 'sameProjectVerified',
    'configPreserved', 'continuationVerified', 'activeToolsVerified',
  ]) assert.equal(evidence[key], true, key);
  assert.match(evidence.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(evidence.clientVersion, /^1\.0\.0-preview\.2$/);
  assert.match(evidence.pluginVersion, /^0\.2\.4$/);
  assert.equal(evidence.transcriptSha256.every((hash) => /^[a-f0-9]{64}$/.test(hash)), true);
}

test('activation writer rejects config drift without writing evidence', async () => {
  await assertWriterRejects((_, input) => {
    input.afterSnapshot.files[CONFIG_KEY] = '0'.repeat(64);
  }, /ACTIVATION_CONFIG_CHANGED/);
});

test('activation writer rejects a different project snapshot', async () => {
  await assertWriterRejects((fixture, input) => {
    input.afterSnapshot.projectRoot = join(fixture.root, 'other-project');
  }, /ACTIVATION_CONTEXT_MISMATCH/);
});

test('activation writer rejects fabricated or malformed snapshots', async () => {
  for (const hash of ['0'.repeat(64), 'not-a-sha256']) {
    await assertWriterRejects((_, input) => {
      input.beforeSnapshot.files[CONFIG_KEY] = hash;
      input.afterSnapshot.files[CONFIG_KEY] = hash;
    }, /ACTIVATION_CONFIG_CHANGED/);
  }
});

test('activation writer re-hashes live config after the snapshots', async () => {
  const fixture = await activationWriterFixture();
  try {
    const input = await writerInput(fixture);
    const configPath = join(fixture.stateDir, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.baseUrl = 'http://127.0.0.1:49999/';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await assert.rejects(recordActivationGate(input), /ACTIVATION_CONFIG_CHANGED/);
    await assert.rejects(access(join(fixture.evidenceDir, 'qwen', 'activation.json')), /ENOENT/);
  } finally {
    await cleanupActivationFixture(fixture);
  }
});

test('activation writer rejects missing or malformed public install evidence', async () => {
  await assertWriterRejects((fixture) => rm(fixture.publicInstallEvidencePath), /ACTIVATION_PUBLIC_EVIDENCE_MISSING/);
  await assertWriterRejects((fixture) => writeFile(fixture.publicInstallEvidencePath, '{bad\n'), /ACTIVATION_PUBLIC_EVIDENCE_INVALID/);
  await assertWriterRejects((fixture) => writePublicEvidence(fixture, { status: 'failed' }), /ACTIVATION_PUBLIC_EVIDENCE_INVALID/);
});

test('activation writer rejects source and client mismatches', async () => {
  await assertWriterRejects((fixture) => writePublicEvidence(fixture, { sourceCommit: 'bad' }), /ACTIVATION_PAYLOAD_MISMATCH/);
  await assertWriterRejects((fixture) => writePublicEvidence(fixture, { clientVersion: '9.9.9' }), /ACTIVATION_CLIENT_MISMATCH/);
});

test('activation writer rejects disabled or wrong-version installed plugins', async () => {
  await assertWriterRejects((_, input) => {
    input.installList[0].enabled = false;
  }, /PUBLIC_INSTALL_PLUGIN_MISSING/);
  await assertWriterRejects((_, input) => {
    input.installList[0].version = '0.2.3';
  }, /ACTIVATION_PAYLOAD_MISMATCH/);
});

test('activation writer rejects install paths outside config or outside transcript plugin root', async () => {
  await assertWriterRejects(async (fixture, input) => {
    const outside = join(fixture.root, '..', 'outside-install');
    await mkdir(outside, { recursive: true });
    input.installList[0].installPath = outside;
  }, /ACTIVATION_CONTEXT_MISMATCH/);
  await assertWriterRejects(async (fixture, input) => {
    const other = join(fixture.root, 'other-install');
    await mkdir(other, { recursive: true });
    input.installList[0].installPath = other;
  }, /ACTIVATION_CONTEXT_MISMATCH/);
});

test('activation writer rejects a failed qwen version probe', async () => {
  await assertWriterRejects((_, input) => {
    input.spawn = () => ({ status: 1, stdout: '', stderr: 'ETIMEDOUT' });
  }, /PUBLIC_INSTALL_CLIENT_VERSION_MISSING/);
});

test('activation writer never overwrites existing evidence on failure', async () => {
  const fixture = await activationWriterFixture();
  try {
    const input = await writerInput(fixture);
    input.afterSnapshot.files[CONFIG_KEY] = '0'.repeat(64);
    const directory = join(fixture.evidenceDir, 'qwen');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'activation.json');
    await writeFile(path, 'sentinel\n');
    await assert.rejects(recordActivationGate(input), /ACTIVATION_CONFIG_CHANGED/);
    assert.equal(await readFile(path, 'utf8'), 'sentinel\n');
  } finally {
    await cleanupActivationFixture(fixture);
  }
});
