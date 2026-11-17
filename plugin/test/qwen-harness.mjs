import { spawn } from 'node:child_process';

export function qwenInit({ qwen, configDir, project }) {
  return new Promise((resolveInit, reject) => {
    const child = spawn(qwen, [
      '--config-dir', configDir, '-p', 'hi', '--output-format', 'stream-json',
      '--no-session-persistence', '--allowed-mcp-server-names', 'bughunter',
    ], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
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
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((value) => value.includes('"subtype":"init"'));
      if (line !== undefined) finish(undefined, JSON.parse(line));
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`qwen exited before init (${code})\n${stderr}\n${stdout}`));
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
