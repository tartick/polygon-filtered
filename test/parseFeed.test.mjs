import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed } from '../src/parseFeed.mjs';

const fixture = readFileSync(new URL('./fixtures/polygon-feed-2026-09-29.xml', import.meta.url), 'utf8');

test('parses all 10 items from the real Polygon feed', () => {
  const items = parseFeed(fixture);
  assert.equal(items.length, 10);
});

test('first item has all fields populated', () => {
  const [first] = parseFeed(fixture);
  assert.equal(first.title, "Magic’s KPop Demon Hunters Secret Lair Is Coming Sooner Than You Think");
  assert.equal(first.link, 'https://www.polygon.com/mtg-kpop-demon-hunters-secret-lair-teaser/');
  assert.equal(first.guid, first.link);
  assert.equal(first.creator, 'Corey Plante');
  assert.match(first.pubDate, /2026/);
  assert.ok(first.categories.includes('Magic: The Gathering'));
  assert.ok(first.categories.includes('News'));
  assert.match(first.description, /Secret Lair crossover/);
  assert.ok(first.contentEncoded.startsWith('<p>'));
  assert.equal(first.enclosure.type, 'image/jpeg');
  assert.match(first.enclosure.url, /^https:\/\/static0\.polygonimages\.com\//);
});

test('guide items carry the Guides category', () => {
  const guide = parseFeed(fixture).find(i => i.link.includes('fire-emblem-fortunes-weave-paralogues'));
  assert.ok(guide.categories.includes('Guides'));
});

test('item with missing optional fields and a single category parses safely', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>x</title>
    <item><title><![CDATA[Solo]]></title><link>https://www.polygon.com/solo/</link><pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate><category><![CDATA[Gaming]]></category></item>
  </channel></rss>`;
  const [item] = parseFeed(xml);
  assert.deepEqual(item.categories, ['Gaming']);
  assert.equal(item.creator, '');
  assert.equal(item.description, '');
  assert.equal(item.contentEncoded, '');
  assert.equal(item.enclosure, null);
});

test('returns [] for a feed with no items', () => {
  assert.deepEqual(parseFeed('<rss><channel><title>x</title></channel></rss>'), []);
});

test('throws on non-RSS input', () => {
  assert.throws(() => parseFeed('<html><body>blocked</body></html>'), /not an RSS feed/);
});
