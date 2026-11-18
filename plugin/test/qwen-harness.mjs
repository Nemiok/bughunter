import { spawn } from 'node:child_process';

// Buffers newline-delimited stream-json output and emits only complete,
// parseable lines whose subtype is "init". Chunks may split a line mid-JSON
// or carry non-JSON noise; both must not crash or false-trigger the probe.
export function makeInitLineProbe(onInit) {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let boundary = pending.indexOf('\n');
    while (boundary !== -1) {
      const line = pending.slice(0, boundary).trim();
      pending = pending.slice(boundary + 1);
      boundary = pending.indexOf('\n');
      if (line === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event !== null && typeof event === 'object' && event.subtype === 'init') {
        onInit(event);
      }
    }
  };
}

export function qwenInit({ qwen, configDir, project }) {
  return new Promise((resolveInit, reject) => {
    const child = spawn(qwen, [
      '--config-dir', configDir, '-p', 'hi', '--output-format', 'stream-json',
      '--no-session-persistence', '--allowed-mcp-server-names', 'bughunter',
    ], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutTail = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error); else resolveInit(value);
    };
    const timer = setTimeout(() => finish(new Error(`qwen init timed out\n${stderr}`)), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const probe = makeInitLineProbe((event) => finish(undefined, event));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdoutTail = (stdoutTail + chunk).slice(-2000);
      probe(chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`qwen exited before init (${code})\n${stderr}\n${stdoutTail}`));
    });
  });
}

export function summarize(event) {
  return {
    mcp: event.mcp_servers.map((server) => `${server.name}:${server.status}`),
    bhTools: event.tools.filter((tool) => tool.startsWith('mcp__bughunter__')),
    skills: event.skills.filter((skill) => skill.startsWith('bughunter:')),
    agents: event.agents.filter((agent) => agent.startsWith('bughunter:')),
  };
}
