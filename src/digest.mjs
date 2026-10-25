import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { newestFirst } from './store.mjs';
import { escHtml } from './buildFeed.mjs';

export const DIGEST_TZ = 'America/New_York';
export const CUTOFF_MINUTES = 23 * 60 + 30; // 11:30 PM local

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: DIGEST_TZ, weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});

export function localParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const month = Number(p.month);
  const day = Number(p.day);
  return {
    ymd: `${p.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    weekday: p.weekday,
    month,
    day,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function slopTitle(date) {
  const p = localParts(date);
  return `Polygon Slop, ${p.weekday} ${p.month}/${p.day}`;
}

export function loadDigests(path) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

const time = d => Date.parse(d.pubDate) || 0;

export function saveDigests(path, digests) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...digests].sort((a, b) => time(b) - time(a)), null, 2) + '\n');
}

export function pruneDigests(digests, now, days = 30) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return digests.filter(d => time(d) >= cutoff);
}

export function maybeAddDigest({ items, digests, now, site }) {
  const unchanged = { digests, added: null };
  const p = localParts(now);
  if (p.minutes < CUTOFF_MINUTES) return unchanged;
  if (digests.some(d => d.localDate === p.ymd)) return unchanged;

  const done = new Set(digests.flatMap(d => d.guids ?? []));
  const candidates = items.filter(i => i.decision === 'toss' && !done.has(i.guid)).sort(newestFirst);
  if (!candidates.length) return unchanged;

  const n = candidates.length;
  const lis = candidates.map(i =>
    `<li><a href="${escHtml(i.link)}">${escHtml(i.title)}</a> — ${escHtml(String(i.reason ?? '').replace(/^Rule: /, ''))}</li>`).join('');
  const html = `<p>${n} ${n === 1 ? 'article' : 'articles'} hidden since the last digest:</p><ul>${lis}</ul>`;

  const added = {
    guid: `${site}/digest/${p.ymd}`,
    link: `${site}/`,
    title: slopTitle(now),
    creator: 'polygon-filtered',
    pubDate: now.toUTCString(),
    categories: ['Digest'],
    description: html,
    contentEncoded: html,
    enclosure: null,
    decision: 'digest', reason: '', decidedBy: null,
    localDate: p.ymd,
    guids: candidates.map(i => i.guid),
  };
  return { digests: [added, ...digests], added };
}
