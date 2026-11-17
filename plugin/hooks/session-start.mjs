#!/usr/bin/env node
// Kimi runs plugin MCP servers with cwd = plugin root, so the server cannot
// see the workspace on its own. The host fires this SessionStart hook with the
// session cwd on stdin; we record it under KIMI_CODE_HOME for the MCP server
// to pick up. Writes are atomic (temp file + rename) and only absolute cwd
// values are accepted; exits 0 on any malformed payload.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw);
    const cwd = payload?.cwd;
    const home = process.env.KIMI_CODE_HOME;
    if (typeof cwd === 'string' && isAbsolute(cwd) && typeof home === 'string' && home.length > 0) {
      const dir = join(home, 'bughunter');
      mkdirSync(dir, { recursive: true });
      const target = join(dir, 'session-cwd');
      const temporary = join(dir, `.session-cwd.${process.pid}.tmp`);
      writeFileSync(temporary, cwd, 'utf8');
      renameSync(temporary, target);
    }
  } catch {}
  process.exit(0);
});
