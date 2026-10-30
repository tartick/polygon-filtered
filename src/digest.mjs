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

const shiftYmd = (ymd, days) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

function titleForDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return `Polygon Slop, ${weekday} ${m}/${d}`;
}

export function slopTitle(date) {
  return titleForDay(localParts(date).ymd);
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

function buildDigest(ymd, list, pubDate, site) {
  const n = list.length;
  const lis = list.map(i =>
    `<li><a href="${escHtml(i.link)}">${escHtml(i.title)}</a> — ${escHtml(String(i.reason ?? '').replace(/^Rule: /, ''))}</li>`).join('');
  const html = `<p>${n} ${n === 1 ? 'article' : 'articles'} hidden since the last digest:</p><ul>${lis}</ul>`;
  return {
    guid: `${site}/digest/${ymd}`,
    link: `${site}/`,
    title: titleForDay(ymd),
    creator: 'polygon-filtered',
    pubDate,
    categories: ['Digest'],
    description: html,
    contentEncoded: html,
    enclosure: null,
    decision: 'digest', reason: '', decidedBy: null,
    localDate: ymd,
    guids: list.map(i => i.guid),
  };
}

// Posts one digest per finished local day (a day finishes at 11:30 PM New York time) that has
// undigested tossed items. GitHub's scheduler runs hours apart, so this catches up on any run.
export function maybeAddDigest({ items, digests, now, site }) {
  const p = localParts(now);
  const lastDay = p.minutes >= CUTOFF_MINUTES ? p.ymd : shiftYmd(p.ymd, -1);
  const digestedDays = new Set(digests.map(d => d.localDate));
  const done = new Set(digests.flatMap(d => d.guids ?? []));

  const byDay = new Map();
  for (const i of items) {
    if (i.decision !== 'toss' || done.has(i.guid)) continue;
    let day = localParts(new Date(i.firstSeen || i.pubDate)).ymd;
    while (digestedDays.has(day)) day = shiftYmd(day, 1); // seen after that day's digest went out
    if (day > lastDay) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  }

  const days = [...byDay.keys()].sort();
  const added = days.map((day, idx) => buildDigest(
    day, byDay.get(day).sort(newestFirst), new Date(now.getTime() - (days.length - 1 - idx) * 1000).toUTCString(), site));
  return { digests: [...[...added].reverse(), ...digests], added };
}
