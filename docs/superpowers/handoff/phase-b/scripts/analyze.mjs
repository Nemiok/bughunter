import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GR = '/Users/nemiok/Desktop/projects/vault/bughunter-phase-b/bughunter-gate/node-model';
const G = join(GR, 'project');
const file = process.argv[2] ?? join(GR, 'node-model.stdout.jsonl');

const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
const events = [];
let unparsed = 0;
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    unparsed += 1;
  }
}

let assistantWithTools = 0;
let batches = 0;
const calls = [];
const sequence = [];
for (const event of events) {
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
  const toolUses = event.message.content.filter((part) => part.type === 'tool_use');
  if (toolUses.length === 0) continue;
  assistantWithTools += 1;
  if (toolUses.length > 1) batches += 1;
  for (const tool of toolUses) {
    const name = tool.name.replace('mcp__bughunter__', '');
    calls.push(name);
    if (name === 'Agent') {
      const kind = `Agent(${tool.input?.subagent_type ?? '?'})`;
      sequence.push(kind);
      console.log(`agent call: ${kind} background=${tool.input?.run_in_background ?? '-'} prompt=${String(tool.input?.prompt ?? '').slice(0, 90).replace(/\n/g, ' ')}`);
    } else if (['bh_explore_next', 'bh_triage', 'bh_export_test', 'bh_verify_red', 'bh_promote_finding', 'bh_start_run', 'bh_finish_run', 'bh_resume_run', 'bh_reproduce', 'bh_sweep'].includes(name)) {
      sequence.push(name);
    }
  }
}

const counts = {};
for (const name of calls) counts[name] = (counts[name] ?? 0) + 1;

// Чередование: после каждого bh_explore_next со статусом task — ровно один Agent(bh-explorer).
let violations = 0;
for (let index = 0; index < sequence.length; index += 1) {
  if (sequence[index] !== 'bh_explore_next') continue;
  const next = sequence[index + 1];
  if (next !== 'Agent(bh-explorer)') {
    violations += 1;
    console.log(`нарушение чередования: после bh_explore_next №${index} идёт ${next ?? '(ничего)'}`);
  }
}

const result = events.filter((event) => event.type === 'result').at(-1);
console.log(`lines=${lines.length} parsed=${events.length} unparsed=${unparsed}`);
console.log(`assistant_messages_with_tools=${assistantWithTools} batches=${batches} (критерий: 0)`);
console.log(`explore_next→Agent(bh-explorer) нарушений: ${violations} (критерий: 0)`);
console.log('tool counts:', JSON.stringify(counts));
console.log('main-agent sequence:', sequence.join(' → '));
if (result) {
  console.log(`result: subtype=${result.subtype} is_error=${result.is_error} turns=${result.num_turns} duration_ms=${result.duration_ms} terminal=${result.terminal_reason ?? '-'}`);
} else {
  console.log('result: (прогон ещё идёт)');
  console.log(`last calls: ${calls.slice(-8).join(' → ')}`);
}

// Состояние прогона в копии.
const runsDir = join(G, '.qwen/bughunter/presets/node/state/runs');
if (existsSync(runsDir)) {
  for (const runId of readdirSync(runsDir)) {
    const runFile = join(runsDir, runId, 'run.json');
    if (!existsSync(runFile)) continue;
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    console.log(`\nrun ${runId}: status=${run.status} stages=${JSON.stringify(run.stages)}`);
    const queue = run.exploreQueue ?? [];
    if (Array.isArray(queue)) {
      const byStatus = {};
      for (const item of queue) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      console.log(`очередь: ${queue.length} задач, ${JSON.stringify(byStatus)}`);
      console.log(`targetStages: ${JSON.stringify(run.targetStages ?? {})}`);
    }
    const candidatesDir = join(runsDir, runId, 'candidates');
    if (existsSync(candidatesDir)) {
      const candidates = readdirSync(candidatesDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(candidatesDir, name), 'utf8')));
      const byStatus = {};
      for (const candidate of candidates) byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
      console.log(`кандидаты: ${candidates.length}, ${JSON.stringify(byStatus)}`);
      for (const candidate of candidates) {
        const tests = (candidate.tests ?? []).map((entry) => `${entry.kind}:${entry.verdict ?? '?'}`).join(',');
        console.log(`  [${candidate.status}] ${candidate.title.slice(0, 70)} | repro=${candidate.reproduction?.status ?? '-'} steps=${candidate.steps?.length ?? 0} minimal=${candidate.minimalSteps?.length ?? '-'} check=${candidate.check ? `${candidate.check.kind}:${candidate.check.pointer ?? candidate.check.target}=${JSON.stringify(candidate.check.expected)}` : '-'} sig=${(candidate.signalIds ?? []).length} | tests=${tests || '-'}`);
      }
    }
    const report = join(runsDir, runId, 'report.md');
    if (existsSync(report)) {
      const text = readFileSync(report, 'utf8');
      const pending = text.match(/^Pending:.*$/m);
      console.log(`report.md: ${pending ? pending[0] : '(строка Pending не найдена)'}, ${text.split('\n').length} строк`);
    }
    const testsDir = join(G, 'test', 'bughunter');
    if (existsSync(testsDir)) console.log('экспортированные тесты:', readdirSync(testsDir).join(', '));
  }
}
