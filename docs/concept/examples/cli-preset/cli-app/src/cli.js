// cli-app/src/cli.js — целевое приложение: учет заказов в JSON-файле.
// Реестр засеянных багов — в SEEDED.md; единственный источник правды — этот код.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const db = process.env.DB_FILE ?? 'orders.json';
const read = () => (existsSync(db) ? JSON.parse(readFileSync(db, 'utf8')) : []);
const [command, ...args] = process.argv.slice(2);

if (command === 'add') {
  const [name, qty] = args;
  const rows = read();
  const total = Number(qty) * 100;      // C2: количество не проверяется, C4: нечисловое дает NaN
  rows.push({ name, qty: Number(qty), total });
  writeFileSync(db, JSON.stringify([...rows], null, 2));  // C3: повторный add пишет вторую строку
  console.log(`ok ${name} total=${total}`);
} else if (command === 'show') {
  const row = read().find((item) => item.name === args[0]);
  console.log(row.total);               // C1: неизвестное имя — необработанное исключение и стек наружу
} else if (command === 'list') {
  console.log(JSON.stringify(read()));  // контроль: команда всегда корректна
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
