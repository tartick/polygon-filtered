import { readFileSync } from 'node:fs';

const DEFAULT_PATH = new URL('../config/rules.json', import.meta.url);

export function loadRules(path = DEFAULT_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const lower = s => s.toLowerCase();

export function applyRules(item, rules) {
  const cats = (item.categories ?? []).map(lower);

  const dropCat = rules.dropCategories.find(c => cats.includes(lower(c)));
  if (dropCat) return { decision: 'toss', reason: `Rule: category "${dropCat}"` };

  const dropPat = rules.dropTitlePatterns.find(p => new RegExp(p, 'i').test(item.title));
  if (dropPat) return { decision: 'toss', reason: 'Rule: streaming clickbait headline' };

  const keepCat = rules.keepCategories.find(c => cats.includes(lower(c)));
  if (keepCat) return { decision: 'keep', reason: `Rule: category "${keepCat}"` };

  return { decision: null, reason: '' };
}
