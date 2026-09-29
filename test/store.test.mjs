import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, saveStore, mergeNew, prune } from '../src/store.mjs';

const now = new Date('2026-09-29T20:00:00Z');
const mk = (guid, pubDate, extra = {}) => ({
  guid, title: guid, link: guid, creator: '', pubDate, categories: [],
  description: '', contentEncoded: '', enclosure: null, ...extra,
});

test('loadStore returns [] when file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  assert.deepEqual(loadStore(join(dir, 'nope.json')), []);
});

test('saveStore then loadStore round-trips, newest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  const path = join(dir, 'sub', 'items.json');
  const items = [
    mk('a', 'Mon, 28 Sep 2026 10:00:00 GMT'),
    mk('b', 'Tue, 29 Sep 2026 10:00:00 GMT'),
  ];
  saveStore(path, items);
  assert.ok(existsSync(path));
  assert.deepEqual(loadStore(path).map(i => i.guid), ['b', 'a']);
});

test('mergeNew adds only unseen guids as pending and leaves existing ones alone', () => {
  const stored = [{ ...mk('a', 'Tue, 29 Sep 2026 10:00:00 GMT'), decision: 'keep', reason: 'r', decidedBy: 'claude', firstSeen: '2026-09-29T10:05:00.000Z' }];
  const fresh = [mk('a', 'Tue, 29 Sep 2026 10:00:00 GMT', { title: 'changed' }), mk('b', 'Tue, 29 Sep 2026 11:00:00 GMT')];
  const { all, added } = mergeNew(stored, fresh, now);
  assert.equal(all.length, 2);
  assert.deepEqual(added.map(i => i.guid), ['b']);
  assert.equal(all.find(i => i.guid === 'a').decision, 'keep');
  assert.equal(all.find(i => i.guid === 'a').title, 'a');
  const b = all.find(i => i.guid === 'b');
  assert.equal(b.decision, null);
  assert.equal(b.decidedBy, null);
  assert.equal(b.reason, '');
  assert.equal(b.firstSeen, now.toISOString());
});

test('mergeNew dedupes duplicate guids within the same fresh batch', () => {
  const { all } = mergeNew([], [mk('a', 'Tue, 29 Sep 2026 10:00:00 GMT'), mk('a', 'Tue, 29 Sep 2026 10:00:00 GMT')], now);
  assert.equal(all.length, 1);
});

test('prune drops items older than 30 days', () => {
  const items = [
    { ...mk('old', 'Fri, 28 Aug 2026 10:00:00 GMT'), firstSeen: '2026-08-28T10:00:00.000Z' },
    { ...mk('new', 'Mon, 28 Sep 2026 10:00:00 GMT'), firstSeen: '2026-09-28T10:00:00.000Z' },
  ];
  assert.deepEqual(prune(items, now).map(i => i.guid), ['new']);
});

test('prune falls back to firstSeen when pubDate is unparseable', () => {
  const items = [
    { ...mk('x', ''), firstSeen: '2026-09-28T10:00:00.000Z' },
    { ...mk('y', 'garbage'), firstSeen: '2026-07-01T10:00:00.000Z' },
  ];
  assert.deepEqual(prune(items, now).map(i => i.guid), ['x']);
});
