import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  BUGHUNTER_AGENTS,
  BUGHUNTER_SKILLS,
  BUGHUNTER_WEB_TOOLS,
  cleanupActivationFixture,
  persistActivationFixture,
  validActivationFixture,
} from './activation-fixture.mjs';
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
