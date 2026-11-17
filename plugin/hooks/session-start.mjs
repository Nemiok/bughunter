#!/usr/bin/env node
// Kimi runs plugin MCP servers with cwd = plugin root, so the server cannot
// see the workspace on its own. The host fires this SessionStart hook with the
// session cwd on stdin; we record it under KIMI_CODE_HOME for the MCP server
// to pick up. Never writes anywhere else, exits 0 on any malformed payload.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw);
    const cwd = payload?.cwd;
    const home = process.env.KIMI_CODE_HOME;
    if (typeof cwd === 'string' && cwd.length > 0 && typeof home === 'string' && home.length > 0) {
      const dir = join(home, 'bughunter');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'session-cwd'), cwd, 'utf8');
    }
  } catch {}
  process.exit(0);
});
