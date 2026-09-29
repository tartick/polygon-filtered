import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyRules, loadRules } from '../src/rules.mjs';

const rules = loadRules();
const examples = JSON.parse(readFileSync(new URL('../config/examples.json', import.meta.url), 'utf8'));
const item = (title, categories = []) => ({ title, categories });

const STREAMING_CLICKBAIT = [
  "Brendan Fraser's 124-Minute Action Thriller Classic Is Back From the Dead on Streaming",
  'Russell Crowe\'s New Crime Thriller Is Already No. 1 on Netflix',
  "35 Years Later, the '90s Remake of a Cult Classic Thriller Is Officially Free to Watch on YouTube",
  'The Definitive \'90s Sci-Fi Action Blockbuster Is Officially Streaming for Free on YouTube',
  'Jason Statham\'s 113-Minute Action Thriller Blasts Back Onto Streaming',
  'This 2014 Action Thriller Is About to Leave Netflix',
];

test('every streaming clickbait headline is tossed by rule', () => {
  for (const t of STREAMING_CLICKBAIT) {
    assert.equal(applyRules(item(t), rules).decision, 'toss', t);
  }
});

test('no labeled KEEP example is tossed by a title rule', () => {
  for (const ex of examples.filter(e => e.decision === 'keep')) {
    assert.notEqual(applyRules(item(ex.title), rules).decision, 'toss', ex.title);
  }
});

test('Guides category is tossed', () => {
  const r = applyRules(item("All paralogue dates and deadlines in Fire Emblem Fortune's Weave", ['Guides', 'Fire Emblem: Fortune\'s Weave']), rules);
  assert.equal(r.decision, 'toss');
  assert.match(r.reason, /Guides/);
});

test('Magic: The Gathering category is always kept', () => {
  const r = applyRules(item('Magic\'s KPop Demon Hunters Secret Lair Is Coming Sooner Than You Think', ['News', 'Magic: The Gathering']), rules);
  assert.equal(r.decision, 'keep');
});

test('drop rules win over keep rules', () => {
  const r = applyRules(item('Every MTG Commander Deck Ranked', ['Guides', 'Magic: The Gathering']), rules);
  assert.equal(r.decision, 'toss');
});

test('category matching is case-insensitive', () => {
  assert.equal(applyRules(item('x', ['guides']), rules).decision, 'toss');
});

test('an ordinary game news item is undecided', () => {
  const r = applyRules(item('The Next Monster Hunter Game Officially Gets a Release Date', ['News', 'Monster Hunter']), rules);
  assert.deepEqual(r, { decision: null, reason: '' });
});
