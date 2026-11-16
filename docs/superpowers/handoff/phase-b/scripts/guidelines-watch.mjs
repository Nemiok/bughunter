// Сводка по JSONL прогона (стрим агента-строителя или модельного прогона).
// Использование: node watch.mjs <jsonl> [--tail N]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node watch.mjs <jsonl> [--tail N]');
const tailIndex = process.argv.indexOf('--tail');
const tail = tailIndex === -1 ? 12 : Number(process.argv[tailIndex + 1] ?? 12);

const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
const events = [];
let unparsed = 0;
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch { unparsed += 1; }
}

const calls = [];
const texts = [];
for (const event of events) {
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
  for (const part of event.message.content) {
    if (part.type === 'tool_use') calls.push(`${part.name}(${String(part.input?.command ?? part.input?.file_path ?? part.input?.description ?? '').slice(0, 70).replace(/\n/g, ' ')})`);
    if (part.type === 'text' && part.text.trim().length > 0) texts.push(part.text.trim().replace(/\n/g, ' ').slice(0, 200));
  }
}

const counts = {};
for (const call of calls) {
  const name = call.slice(0, call.indexOf('('));
  counts[name] = (counts[name] ?? 0) + 1;
}

const result = events.filter((event) => event.type === 'result').at(-1);
console.log(`lines=${lines.length} parsed=${events.length} unparsed=${unparsed}`);
console.log(`tool calls=${calls.length} counts=${JSON.stringify(counts)}`);
console.log(`last ${Math.min(tail, calls.length)} calls:`);
for (const call of calls.slice(-tail)) console.log(`  ${call}`);
if (texts.length > 0) {
  console.log(`last text: ${texts.at(-1)}`);
}
if (result) {
  console.log(`result: subtype=${result.subtype} is_error=${result.is_error} turns=${result.num_turns} duration_ms=${result.duration_ms}`);
} else {
  console.log('result: (прогон ещё идёт)');
}
