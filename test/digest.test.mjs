import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localParts, slopTitle, maybeAddDigest, pruneDigests, loadDigests, saveDigests } from '../src/digest.mjs';
import { buildFeed } from '../src/buildFeed.mjs';
import { parseFeed } from '../src/parseFeed.mjs';

const site = 'https://example.test/pf';
const item = (n, decision, over = {}) => ({
  guid: `https://www.polygon.com/a-${n}/`, link: `https://www.polygon.com/a-${n}/`, title: `Article ${n}`,
  description: 'd', categories: [], pubDate: new Date(Date.UTC(2026, 10, 30, n)).toUTCString(),
  decision, reason: decision === 'toss' ? `Rule: reason ${n}` : '', decidedBy: null, ...over,
});
const due = new Date('2026-12-01T04:35:00Z'); // 11:35 PM EST Nov 30

test('slopTitle in EDT', () => {
  assert.equal(slopTitle(new Date('2026-10-26T03:40:00Z')), 'Polygon Slop, Sunday 10/25');
});

test('winter/EST parts and title', () => {
  const p = localParts(due);
  assert.equal(p.ymd, '2026-11-30');
  assert.equal(p.minutes, 23 * 60 + 35);
  assert.equal(slopTitle(due), 'Polygon Slop, Monday 11/30');
});

test('not due before 11:30 PM local', () => {
  const digests = [];
  const r = maybeAddDigest({ items: [item(1, 'toss')], digests, now: new Date('2026-12-01T04:25:00Z'), site });
  assert.equal(r.added, null);
  assert.deepEqual(r.digests, []);
});

test('due: digests tossed items only, newest first', () => {
  const items = [item(1, 'toss'), item(2, 'keep'), item(3, 'toss'), item(4, null)];
  const { digests, added } = maybeAddDigest({ items, digests: [], now: due, site });
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

test('same local date: no second digest', () => {
  const items = [item(1, 'toss')];
  const first = maybeAddDigest({ items, digests: [], now: due, site });
  const again = maybeAddDigest({ items: [...items, item(5, 'toss')], digests: first.digests, now: new Date('2026-12-01T04:55:00Z'), site });
  assert.equal(again.added, null);
  assert.equal(again.digests.length, 1);
});

test('next night only includes newly tossed', () => {
  const items = [item(1, 'toss'), item(3, 'toss')];
  const first = maybeAddDigest({ items, digests: [], now: due, site });
  const items2 = [...items, item(7, 'toss')];
  const second = maybeAddDigest({ items: items2, digests: first.digests, now: new Date('2026-12-02T04:35:00Z'), site });
  assert.deepEqual(second.added.guids, [items2[2].guid]);
  assert.equal(second.digests.length, 2);
  assert.equal(second.digests[0], second.added);
});

test('no undigested tossed items', () => {
  const items = [item(1, 'toss')];
  const first = maybeAddDigest({ items, digests: [], now: due, site });
  const r = maybeAddDigest({ items, digests: first.digests, now: new Date('2026-12-02T04:35:00Z'), site });
  assert.equal(r.added, null);
  assert.equal(r.digests.length, 1);
});

test('html escaping and round trip through buildFeed', () => {
  const items = [item(1, 'toss', { title: 'Tom & Jerry <script>', reason: 'a "b" \'c\'' })];
  const { added } = maybeAddDigest({ items, digests: [], now: due, site });
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
  const { added } = maybeAddDigest({ items: [item(1, 'toss')], digests: [], now: due, site });
  assert.match(added.description, /1 article hidden/);
});

test('load/save round trip, missing file', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'pf-dg-')), 'sub', 'digests.json');
  assert.deepEqual(loadDigests(p), []);
  saveDigests(p, [{ pubDate: 'Mon, 01 Dec 2026 04:35:00 GMT', x: 1 }, { pubDate: 'Tue, 02 Dec 2026 04:35:00 GMT', x: 2 }]);
  assert.ok(existsSync(p));
  assert.deepEqual(loadDigests(p).map(d => d.x), [2, 1]);
});
