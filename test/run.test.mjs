import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { fetchFeed } from '../src/fetchFeed.mjs';
import { parseFeed } from '../src/parseFeed.mjs';

const fixture = readFileSync(new URL('./fixtures/polygon-feed-2026-09-29.xml', import.meta.url), 'utf8');
const now = new Date('2026-09-29T20:00:00Z');
const okFetch = async () => new Response(fixture, { status: 200 });
const tmp = () => mkdtempSync(join(tmpdir(), 'pf-run-'));

// Fake Claude: keeps everything it is asked about.
const keepAllClient = () => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const ids = JSON.parse(params.messages[0].content.split('\n\n').slice(1).join('\n\n')).map(i => i.id);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ decisions: ids.map(id => ({ id, decision: 'keep', reason: 'test' })) }) }] };
      },
    },
  };
};

test('full run: rules + Claude decide, feeds and state written', async () => {
  const root = tmp();
  const client = keepAllClient();
  const summary = await run({ fetchImpl: okFetch, client, now, root });
  assert.equal(summary.added, 10);
  assert.equal(summary.pending, 0);
  // Guides item is tossed by rule; MTG item kept by rule; Brendan Fraser streaming item tossed by rule.
  const rejected = parseFeed(readFileSync(join(root, 'public/rejected.xml'), 'utf8'));
  assert.ok(rejected.some(i => i.link.includes('fire-emblem-fortunes-weave-paralogues')));
  assert.ok(rejected.some(i => i.link.includes('brendan-fraser-the-mummy-streaming')));
  const kept = parseFeed(readFileSync(join(root, 'public/feed.xml'), 'utf8'));
  assert.ok(kept.some(i => i.link.includes('mtg-kpop')));
  // Claude was only asked about items the rules didn't decide.
  const asked = client.calls[0].messages[0].content;
  assert.doesNotMatch(asked, /mtg-kpop/);
  assert.doesNotMatch(asked, /paralogues/);
  const state = JSON.parse(readFileSync(join(root, 'data/items.json'), 'utf8'));
  assert.equal(state.length, 10);
  assert.ok(state.every(i => i.decision === 'keep' || i.decision === 'toss'));
});

test('second run with the same feed adds nothing and does not call Claude', async () => {
  const root = tmp();
  await run({ fetchImpl: okFetch, client: keepAllClient(), now, root });
  const client = keepAllClient();
  const summary = await run({ fetchImpl: okFetch, client, now, root });
  assert.equal(summary.added, 0);
  assert.equal(client.calls.length, 0);
  assert.equal(JSON.parse(readFileSync(join(root, 'data/items.json'), 'utf8')).length, 10);
});

test('no API client: rule decisions published, rest pending, retried later', async () => {
  const root = tmp();
  const first = await run({ fetchImpl: okFetch, client: null, now, root });
  assert.ok(first.pending > 0);
  assert.ok(first.kept >= 1);      // MTG by rule
  assert.ok(first.tossed >= 2);    // Guides + streaming clickbait by rule
  assert.ok(existsSync(join(root, 'public/feed.xml')));
  const client = keepAllClient();
  const second = await run({ fetchImpl: okFetch, client, now, root });
  assert.equal(client.calls.length, 1);
  assert.equal(second.pending, 0);
});

test('fetch failure throws and leaves existing outputs untouched', async () => {
  const root = tmp();
  await run({ fetchImpl: okFetch, client: keepAllClient(), now, root });
  const before = readFileSync(join(root, 'public/feed.xml'), 'utf8');
  const badFetch = async () => new Response('<html>blocked</html>', { status: 200 });
  await assert.rejects(run({ fetchImpl: badFetch, client: keepAllClient(), now, root, fetchOpts: { delayMs: 0 } }));
  assert.equal(readFileSync(join(root, 'public/feed.xml'), 'utf8'), before);
});

test('dryRun writes nothing', async () => {
  const root = tmp();
  await run({ fetchImpl: okFetch, client: keepAllClient(), now, root, dryRun: true });
  assert.equal(existsSync(join(root, 'public/feed.xml')), false);
  assert.equal(existsSync(join(root, 'data/items.json')), false);
});

test('fetchFeed retries then succeeds', async () => {
  let n = 0;
  const flaky = async () => { n += 1; if (n < 3) throw new TypeError('fetch failed'); return new Response(fixture, { status: 200 }); };
  const xml = await fetchFeed({ fetchImpl: flaky, delayMs: 0 });
  assert.equal(n, 3);
  assert.match(xml, /<rss/);
});

test('fetchFeed gives up after N attempts', async () => {
  let n = 0;
  const dead = async () => { n += 1; return new Response('nope', { status: 503 }); };
  await assert.rejects(fetchFeed({ fetchImpl: dead, delayMs: 0, attempts: 4 }), /503/);
  assert.equal(n, 4);
});

test('large backlog is classified in chunks of at most 20', async () => {
  const root = tmp();
  const stored = Array.from({ length: 45 }, (_, n) => ({
    guid: `https://www.polygon.com/some-game-news-${n}/`,
    link: `https://www.polygon.com/some-game-news-${n}/`,
    title: `Some Game News ${n}`,
    description: 'Nothing special.',
    categories: [],
    pubDate: new Date(now.getTime() - (n + 1) * 60000).toUTCString(),
    decision: null, reason: '', decidedBy: null, firstSeen: now.toISOString(),
  }));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/items.json'), JSON.stringify(stored));
  const client = keepAllClient();
  await run({ fetchImpl: okFetch, client, now, root });
  assert.equal(client.calls.length, 3);
  for (const c of client.calls) {
    const n = JSON.parse(c.messages[0].content.split('\n\n').slice(1).join('\n\n')).length;
    assert.ok(n <= 20);
  }
  const state = JSON.parse(readFileSync(join(root, 'data/items.json'), 'utf8'));
  assert.ok(state.filter(i => i.title.startsWith('Some Game News')).every(i => i.decision === 'keep'));
  assert.ok(state.every(i => i.decision !== null));
});

test('nightly digest: added once after 11:30 PM ET, not before, not twice', async () => {
  const root = tmp();
  const night = new Date('2026-09-30T03:40:00Z'); // 11:40 PM EDT Sep 29
  const s1 = await run({ fetchImpl: okFetch, client: keepAllClient(), now: night, root });
  assert.equal(s1.digest, 'Polygon Slop, Tuesday 9/29');
  const digests = JSON.parse(readFileSync(join(root, 'data/digests.json'), 'utf8'));
  assert.equal(digests.length, 1);
  const feed = parseFeed(readFileSync(join(root, 'public/feed.xml'), 'utf8'));
  const entry = feed.find(i => i.title === 'Polygon Slop, Tuesday 9/29');
  assert.ok(entry);
  assert.match(entry.description, /fire-emblem-fortunes-weave-paralogues/);
  const s2 = await run({ fetchImpl: okFetch, client: keepAllClient(), now: new Date(night.getTime() + 20 * 60000), root });
  assert.equal(s2.digest, null);
  assert.equal(JSON.parse(readFileSync(join(root, 'data/digests.json'), 'utf8')).length, 1);
});

test('no digest at 4 PM ET', async () => {
  const root = tmp();
  const s = await run({ fetchImpl: okFetch, client: keepAllClient(), now: new Date('2026-09-29T20:00:00Z'), root });
  assert.equal(s.digest, null);
});
