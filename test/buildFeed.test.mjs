import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed } from '../src/parseFeed.mjs';
import { buildFeed } from '../src/buildFeed.mjs';

const fixture = readFileSync(new URL('./fixtures/polygon-feed-2026-09-29.xml', import.meta.url), 'utf8');
const opts = { title: 'Polygon (filtered)', description: 'd', selfUrl: 'https://tartick.github.io/polygon-filtered/feed.xml', now: new Date('2026-09-29T20:00:00Z') };

test('round-trips real Polygon items through build → parse', () => {
  const items = parseFeed(fixture).map(i => ({ ...i, decision: 'keep', reason: 'r' }));
  const again = parseFeed(buildFeed(items, opts));
  assert.equal(again.length, items.length);
  const orig = items.find(i => i.link.includes('mtg-kpop'));
  const back = again.find(i => i.link === orig.link);
  assert.equal(back.title, orig.title);
  assert.equal(back.creator, orig.creator);
  assert.deepEqual(back.categories, orig.categories);
  assert.equal(back.description, orig.description);
  assert.equal(back.contentEncoded, orig.contentEncoded);
  assert.deepEqual(back.enclosure, orig.enclosure);
});

test('channel metadata and self link are present', () => {
  const xml = buildFeed([], opts);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<title>Polygon \(filtered\)<\/title>/);
  assert.match(xml, /<atom:link href="https:\/\/tartick\.github\.io\/polygon-filtered\/feed\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(xml, /<lastBuildDate>Tue, 29 Sep 2026 20:00:00 GMT<\/lastBuildDate>/);
});

test('hostile characters survive: & < quotes in title, ]]> in content', () => {
  const item = {
    guid: 'https://www.polygon.com/a?x=1&y=2', link: 'https://www.polygon.com/a?x=1&y=2',
    title: 'Tom & Jerry <3 "quotes"', creator: 'A & B', pubDate: 'Tue, 29 Sep 2026 10:00:00 GMT',
    categories: ['R&D'], description: 'desc with ]]> inside', contentEncoded: '<p>html ]]> here</p>',
    enclosure: null, decision: 'keep', reason: '',
  };
  const [back] = parseFeed(buildFeed([item], opts));
  assert.equal(back.title, item.title);
  assert.equal(back.link, item.link);
  assert.equal(back.creator, item.creator);
  assert.deepEqual(back.categories, ['R&D']);
  assert.equal(back.description, item.description);
  assert.equal(back.contentEncoded, item.contentEncoded);
  assert.equal(back.enclosure, null);
});

test('limits to newest N items', () => {
  const items = Array.from({ length: 60 }, (_, n) => ({
    guid: `g${n}`, link: `https://x/${n}`, title: `t${n}`, creator: '', categories: [],
    pubDate: new Date(Date.UTC(2026, 8, 1) + n * 3600_000).toUTCString(),
    description: '', contentEncoded: '', enclosure: null, decision: 'keep', reason: '',
  }));
  const back = parseFeed(buildFeed(items, { ...opts, limit: 50 }));
  assert.equal(back.length, 50);
  assert.equal(back[0].title, 't59');
});

test('showReason prefixes description with the filter reason', () => {
  const item = { guid: 'g', link: 'https://x/g', title: 't', creator: '', categories: [], pubDate: 'Tue, 29 Sep 2026 10:00:00 GMT', description: 'orig', contentEncoded: '', enclosure: null, decision: 'toss', reason: 'Marvel churn' };
  const [back] = parseFeed(buildFeed([item], { ...opts, showReason: true }));
  assert.equal(back.description, '[Filtered: Marvel churn] orig');
});
