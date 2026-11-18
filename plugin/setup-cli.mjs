import { host } from './host.mjs';
import { runSetupCli } from './setup-cli-core.mjs';

try {
  await runSetupCli(process.argv.slice(2), { host, serverRoot: import.meta.dirname });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
