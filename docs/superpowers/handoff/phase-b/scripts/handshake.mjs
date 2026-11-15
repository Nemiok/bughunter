// stdio-рукопожатие с точкой входа пресета по образцу portable.bhtest.ts, но без SDK:
// голый JSON-RPC поверх потока строк, поэтому скрипт работает в любой копии.
// Использование: node handshake.mjs <корень копии> [путь входа]
import { spawn } from 'node:child_process';

const cwd = process.argv[2];
const entry = process.argv[3] ?? '.qwen/bughunter/presets/cli/src/index.ts';
if (!cwd) throw new Error('нужен корень копии');

const child = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const pending = new Map();
let nextId = 1;
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line.length === 0) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }
});

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`TIMEOUT ${method}`));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bh-guidelines-handshake', version: '0.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await request('tools/list', {});
  const names = (listed.tools ?? []).map((tool) => tool.name).sort();
  console.log(`server: ${initialized.serverInfo?.name ?? '?'} ${initialized.serverInfo?.version ?? ''}`.trim());
  console.log(`protocol: ${initialized.protocolVersion}`);
  console.log(`tools=${names.length}`);
  console.log(names.join(' '));
} catch (error) {
  console.error(`handshake failed: ${error.message}`);
  if (stderr.trim().length > 0) console.error(stderr.trim().split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
