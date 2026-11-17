import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const projectRoot = join(import.meta.dirname, '../../../..');

const docs = {
  root: 'README.md',
  preset: '.qwen/bughunter/README.md',
  nodePreset: '.qwen/bughunter/presets/node/README.md',
  contractSkill: '.qwen/skills/bughunter-core-contract/SKILL.md',
  invariants: 'docs/concept/invariants.md',
  guide: 'docs/concept/preset-guide.md',
};

/** Идентификатор прогона, который ядро пишет в `run.json` и в отчёт. */
const runId = /\b20\d{6}T\d{6}\.\d{3}Z-[0-9a-f]{12}\b/;

async function read(relativePath: string): Promise<string> {
  return readFile(join(projectRoot, relativePath), 'utf8');
}

function sections(body: string): Array<{ heading: string; text: string }> {
  const result: Array<{ heading: string; text: string }> = [{ heading: '<preamble>', text: '' }];
  for (const line of body.split('\n')) {
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) {
      result.push({ heading: heading[1], text: '' });
      continue;
    }
    result[result.length - 1].text += `${line}\n`;
  }
  return result;
}

test('the root readme names both domains and the copy-the-example rule', async () => {
  const body = await read(docs.root);
  for (const required of ['core', 'preset', 'пример копируй, core подключай']) {
    assert.ok(body.toLowerCase().includes(required.toLowerCase()), `root readme missing: ${required}`);
  }
  // Точка входа концепции ведёт к прозе и к гайду, а не подменяет их.
  for (const link of ['docs/concept/invariants.md', 'docs/concept/preset-guide.md', 'bughunter-preset-guide']) {
    assert.ok(body.includes(link), `root readme does not link: ${link}`);
  }
});

test('the readme does not claim unverified gates', async () => {
  for (const file of [docs.root, docs.preset]) {
    const body = await read(file);

    // Статус READY без идентификатора прогона — заявление без доказательства (инвариант 2).
    for (const paragraph of body.split(/\n{2,}/)) {
      if (/\bREADY\b/.test(paragraph)) {
        assert.ok(runId.test(paragraph), `${file}: READY without a run id — ${paragraph.split('\n')[0]}`);
      }
    }

    // Каждый раздел, который выносит вердикт по гейту, называет прогон, которым гейт получен.
    // Вердикт бывает и в заголовке раздела, поэтому смотрят на заголовок вместе с текстом.
    const gateSections = sections(body).filter(
      (section) => /гейт/i.test(section.heading) && /\b(PASS|FAIL)\b/.test(`${section.heading}\n${section.text}`),
    );
    assert.ok(gateSections.length >= 3, `${file}: found ${gateSections.length} gate sections, expected at least 3`);
    for (const section of gateSections) {
      assert.ok(
        runId.test(section.text) || runId.test(section.heading),
        `${file}: gate verdict without a run id — ${section.heading}`,
      );
    }
  }
});

test('the concept docs restate the invariants and the preset guide', async () => {
  const invariants = await read(docs.invariants);
  const numbered = invariants.match(/^\d+\.\s/gm) ?? [];
  assert.ok(numbered.length >= 7, `invariants doc lists ${numbered.length} invariants, expected 7`);
  for (const required of ['core', 'preset', 'ноль правок core']) {
    assert.ok(invariants.toLowerCase().includes(required.toLowerCase()), `invariants doc missing: ${required}`);
  }

  const guide = await read(docs.guide);
  const guideLower = guide.toLowerCase();
  for (const required of ['пример копируй, core подключай', '@bughunter/core', 'presets/web', 'ноль правок core']) {
    assert.ok(guideLower.includes(required.toLowerCase()), `preset guide doc missing: ${required}`);
  }
  assert.ok(guide.includes('```'), 'preset guide doc must carry a snippet');
  assert.match(guide, /bughunter-preset-guide/, 'the prose guide must point at the skill the model reads');
});

const presetVocabulary = [
  /\bplaywright\b/i, /\burl\b/i, /\bwidget\b/i, /\bnavigate\b/i, /\bprobe\b/i,
  /\bjsonPath\b/, /\bheaderContains\b/, /экран/i, /маршрут/i, /эндпоинт/i, /виджет/i, /браузер/i,
];

test('the core contract skill speaks no preset vocabulary', async () => {
  const body = await read(docs.contractSkill);
  const hits = presetVocabulary.filter((pattern) => pattern.test(body)).map((pattern) => String(pattern));
  assert.deepEqual(hits, [], `preset vocabulary in the core contract skill: ${hits.join(', ')}`);
});

test('the root readme names both presets and their research unit', async () => {
  const body = await read(docs.root);
  for (const required of ['presets/web', 'presets/node', '@bughunter/node']) {
    assert.ok(body.includes(required), `root readme missing: ${required}`);
  }
  // Единица исследования каждого пресета названа явно: без этого «два пресета» — просто слова.
  assert.match(body, /экран/i);
  assert.match(body, /эндпоинт/i);
  // Протокол воспроизведения принадлежит core, а не пресету.
  assert.ok(!/replay вместе с протоколом воспроизведения/.test(body), 'протокол воспроизведения приписан пресету');
});

test('the contract skill no longer defers what core already owns', async () => {
  const skill = await read(docs.contractSkill);
  const section = skill.match(/^## Что объявлено, но ещё не перенесено в core\n([\s\S]*?)(?=^## )/m);
  assert.ok(section, 'раздел границы в контракт-скилле не найден');
  assert.ok(!/протокол воспроизведения/i.test(section[1]), 'протокол воспроизведения уже в core');
  assert.match(section[1], /LIMIT_REACHED/);
  assert.match(section[1], /limits\.candidatesPerRun/);
  assert.match(skill, /core\/src\/reproduce\.ts/);
  assert.match(skill, /reproductionBudget/);
  // Заглушки в поставляемом пресете запрещены, и это проверяется тестом, а не обещанием.
  assert.match(skill, /contract-usage/);
});

/**
 * Раздел «объявлено, но не перенесено» задачей 11 был исправлен, а строка таблицы границы
 * осталась с прежней формулировкой; приёмка гайдлайнов нашла это расхождение (C4).
 */
test('the boundary table does not defer the reproduction protocol to the preset', async () => {
  for (const file of [docs.contractSkill, docs.invariants]) {
    const body = await read(file);
    const row = body.split('\n').find((line) => /^\| Воспроизведение \|/.test(line));
    assert.ok(row, `${file}: строка «Воспроизведение» в таблице границы не найдена`);
    assert.ok(
      !/живут в пресете|а сегодня также протокол/i.test(row),
      `${file}: таблица границы всё ещё отдаёт протокол воспроизведения пресету`,
    );
    assert.match(row, /протокол|бюджет/i);
  }
});

test('the node readme states the install command and the five tools', async () => {
  const body = await read(docs.nodePreset);
  assert.match(body, /npm ci/);
  assert.match(body, /\.mcp\.json/);
  assert.match(body, /presets\/node\/src\/index\.ts/);
  for (const tool of ['bh_open', 'bh_state', 'bh_act', 'bh_sweep', 'bh_close']) {
    assert.ok(body.includes(tool), `в README node-пресета нет инструмента ${tool}`);
  }
  for (const foreign of ['bh_navigate', 'bh_probe', 'bh_crawl']) {
    assert.ok(!body.includes(foreign), `в README node-пресета чужой инструмент ${foreign}`);
  }
  assert.match(body, /node-api-app/);
});
