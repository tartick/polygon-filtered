import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localParts, slopTitle, maybeAddDigest, pruneDigests, loadDigests, saveDigests } from '../src/digest.mjs';
import { buildFeed } from '../src/buildFeed.mjs';
import { parseFeed } from '../src/parseFeed.mjs';

const site = 'https://example.test/pf';
// firstSeen defaults to 3 PM EST Mon Nov 30.
const item = (n, decision, over = {}) => ({
  guid: `https://www.polygon.com/a-${n}/`, link: `https://www.polygon.com/a-${n}/`, title: `Article ${n}`,
  description: 'd', categories: [], pubDate: new Date(Date.UTC(2026, 10, 30, 12 + n)).toUTCString(),
  firstSeen: '2026-11-30T20:00:00.000Z',
  decision, reason: decision === 'toss' ? `Rule: reason ${n}` : '', decidedBy: null, ...over,
});
const due = new Date('2026-12-01T04:35:00Z'); // 11:35 PM EST Nov 30
const afterMidnight = new Date('2026-12-01T05:30:00Z'); // 12:30 AM EST Dec 1

test('slopTitle in EDT', () => {
  assert.equal(slopTitle(new Date('2026-10-26T03:40:00Z')), 'Polygon Slop, Sunday 10/25');
});

test('winter/EST parts and title', () => {
  const p = localParts(due);
  assert.equal(p.ymd, '2026-11-30');
  assert.equal(p.minutes, 23 * 60 + 35);
  assert.equal(slopTitle(due), 'Polygon Slop, Monday 11/30');
});

test("before 11:30 PM local, today's items wait", () => {
  const r = maybeAddDigest({ items: [item(1, 'toss')], digests: [], now: new Date('2026-12-01T04:25:00Z'), site });
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.digests, []);
});

test('due: digests tossed items only, newest first', () => {
  const items = [item(1, 'toss'), item(2, 'keep'), item(3, 'toss'), item(4, null)];
  const { digests, added: [added] } = maybeAddDigest({ items, digests: [], now: due, site });
  assert.deepEqual(added.guids, [items[2].guid, items[0].guid]);
  assert.equal(added.title, 'Polygon Slop, Monday 11/30');
  assert.equal(added.localDate, '2026-11-30');
  assert.equal(added.guid, `${site}/digest/2026-11-30`);
  assert.equal(digests.length, 1);
  assert.match(added.description, /2 articles hidden/);
  assert.match(added.description, /<a href="https:\/\/www\.polygon\.com\/a-1\/">Article 1<\/a> — reason 1/);
  assert.match(added.description, /reason 3/);
  assert.doesNotMatch(added.description, /Rule: /);
  assert.equal(added.contentEncoded, added.description);
});

test("first run after midnight posts yesterday's digest, not today's items", () => {
  const items = [item(1, 'toss'), item(2, 'toss', { firstSeen: '2026-12-01T05:10:00.000Z' })];
  const { added } = maybeAddDigest({ items, digests: [], now: afterMidnight, site });
  assert.equal(added.length, 1);
  assert.equal(added[0].title, 'Polygon Slop, Monday 11/30');
  assert.deepEqual(added[0].guids, [items[0].guid]);
});

test('missed days each get their own digest, oldest first; empty days skipped', () => {
  const items = [
    item(1, 'toss', { firstSeen: '2026-11-28T20:00:00.000Z' }),
    item(2, 'toss'),
    item(3, 'toss', { firstSeen: '2026-11-28T21:00:00.000Z' }),
  ];
  const { digests, added } = maybeAddDigest({ items, digests: [], now: afterMidnight, site });
  assert.deepEqual(added.map(d => d.title), ['Polygon Slop, Saturday 11/28', 'Polygon Slop, Monday 11/30']);
  assert.equal(added[0].guids.length, 2);
  assert.deepEqual(digests.map(d => d.localDate), ['2026-11-30', '2026-11-28']);
  assert.ok(Date.parse(added[0].pubDate) < Date.parse(added[1].pubDate));
});

test('same local date: no second digest; late items roll into the next day', () => {
  const items = [item(1, 'toss')];
  const first = maybeAddDigest({ items, digests: [], now: due, site });
  const late = item(5, 'toss', { firstSeen: '2026-12-01T04:50:00.000Z' }); // 11:50 PM same day
  const again = maybeAddDigest({ items: [...items, late], digests: first.digests, now: new Date('2026-12-01T04:55:00Z'), site });
  assert.deepEqual(again.added, []);
  assert.equal(again.digests.length, 1);
  const next = maybeAddDigest({ items: [...items, late], digests: first.digests, now: new Date('2026-12-02T05:30:00Z'), site });
  assert.equal(next.added.length, 1);
  assert.equal(next.added[0].title, 'Polygon Slop, Tuesday 12/1');
  assert.deepEqual(next.added[0].guids, [late.guid]);
});

test('next night only includes newly tossed', () => {
  const items = [item(1, 'toss'), item(3, 'toss')];
  const first = maybeAddDigest({ items, digests: [], now: due, site });
  const items2 = [...items, item(7, 'toss', { firstSeen: '2026-12-01T20:00:00.000Z' })];
  const second = maybeAddDigest({ items: items2, digests: first.digests, now: new Date('2026-12-02T04:35:00Z'), site });
  assert.deepEqual(second.added.map(d => d.guids), [[items2[2].guid]]);
  assert.equal(second.digests.length, 2);
  assert.equal(second.digests[0], second.added[0]);
});

test('no undigested tossed items', () => {
  const items = [item(1, 'toss')];
  const first = maybeAddDigest({ items, digests: [], now: due, site });
  const r = maybeAddDigest({ items, digests: first.digests, now: new Date('2026-12-02T04:35:00Z'), site });
  assert.deepEqual(r.added, []);
  assert.equal(r.digests.length, 1);
});

test('html escaping and round trip through buildFeed', () => {
  const items = [item(1, 'toss', { title: 'Tom & Jerry <script>', reason: 'a "b" \'c\'' })];
  const { added: [added] } = maybeAddDigest({ items, digests: [], now: due, site });
  assert.match(added.description, /Tom &amp; Jerry &lt;script&gt;/);
  assert.match(added.description, /a &quot;b&quot; &#39;c&#39;/);
  const back = parseFeed(buildFeed([added], { title: 't', description: 'd', selfUrl: 'u', now: due }));
  assert.equal(back[0].description, added.description);
});

test('pruneDigests', () => {
  const old = { pubDate: new Date('2026-09-01T00:00:00Z').toUTCString() };
  const recent = { pubDate: new Date('2026-11-25T00:00:00Z').toUTCString() };
  assert.deepEqual(pruneDigests([old, recent], due), [recent]);
});

test('singular wording', () => {
  const { added: [added] } = maybeAddDigest({ items: [item(1, 'toss')], digests: [], now: due, site });
  assert.match(added.description, /1 article hidden/);
});

test('load/save round trip, missing file', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'pf-dg-')), 'sub', 'digests.json');
  assert.deepEqual(loadDigests(p), []);
  saveDigests(p, [{ pubDate: 'Mon, 01 Dec 2026 04:35:00 GMT', x: 1 }, { pubDate: 'Tue, 02 Dec 2026 04:35:00 GMT', x: 2 }]);
  assert.ok(existsSync(p));
  assert.deepEqual(loadDigests(p).map(d => d.x), [2, 1]);
});
