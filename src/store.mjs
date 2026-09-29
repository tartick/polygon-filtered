import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const time = item => {
  const t = Date.parse(item.pubDate);
  return Number.isNaN(t) ? Date.parse(item.firstSeen ?? '') || 0 : t;
};

export const newestFirst = (a, b) => time(b) - time(a);

export function loadStore(path) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveStore(path, items) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...items].sort(newestFirst), null, 2) + '\n');
}

export function mergeNew(stored, fresh, now) {
  const seen = new Set(stored.map(i => i.guid));
  const added = [];
  for (const item of fresh) {
    if (seen.has(item.guid)) continue;
    seen.add(item.guid);
    added.push({ ...item, decision: null, reason: '', decidedBy: null, firstSeen: now.toISOString() });
  }
  return { all: [...stored, ...added], added };
}

export function prune(items, now, days = 30) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return items.filter(i => time(i) >= cutoff);
}
