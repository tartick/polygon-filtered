# Polygon Filtered Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Action that polls Polygon's RSS feed every 30 minutes, filters it with hard rules + Claude Haiku against Steven's taste, and publishes `feed.xml` / `rejected.xml` on GitHub Pages.

**Architecture:** Small single-purpose ES modules in `src/` (fetch → parse → rules → classify → store → build), orchestrated by `src/run.mjs`. State lives in `data/items.json` committed to the repo; outputs go to `public/` and are deployed with `actions/deploy-pages`.

**Tech Stack:** Node 24 (ESM, `.mjs`), `fast-xml-parser` v5, `@anthropic-ai/sdk`, `node:test`, GitHub Actions + Pages.

**Spec:** `docs/superpowers/specs/2026-09-29-polygon-filtered-feed-design.md`

## Global Constraints

- Repo root: `~/Documents/Claude/polygon-filtered` (git already initialized on `main`; spec + fixture already committed/present).
- Node 24, ES modules only (`"type": "module"`); no TypeScript, no build step.
- Runtime deps limited to `fast-xml-parser` and `@anthropic-ai/sdk`. Tests use `node:test` + `node:assert/strict` only.
- Model ID: exactly `claude-haiku-4-5`.
- Source feed: `https://www.polygon.com/feed/`. Public feed URL: `https://tartick.github.io/polygon-filtered/feed.xml`.
- Output feed caps: newest 50 items each for `feed.xml` and `rejected.xml`.
- State pruning: drop stored items whose `pubDate` is older than 30 days.
- `guid` for a Polygon item = its `<link>` (Polygon items have no `<guid>`).
- Polygon's server drops HTTP/2 connections; use Node's built-in `fetch` (HTTP/1.1) with a browser-like `User-Agent`, up to 4 attempts.
- Never commit or log an API key. The key reaches CI only via the `ANTHROPIC_API_KEY` repo secret.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **A feed item missing optional fields** (no `<enclosure>`, no `<content:encoded>`, exactly one `<category>`, no `<dc:creator>`) must parse to a well-formed item (empty strings / empty array / `null` enclosure), not crash. → test in Task 1.
2. **HTML content containing `]]>` or titles containing `&`, `<`, quotes** must produce valid XML that round-trips through `parseFeed`. → test in Task 4.
3. **Claude returns decisions for only some items, unknown ids, or garbage JSON** → known ids get decisions, the rest stay pending (`decision: null`), nothing throws. → tests in Task 5.
4. **No API key / API down** → rule-decided items still published, feed still built, pending items retried next run. → test in Task 6.
5. **An item seen on a previous run reappears** (Polygon's 10-item window overlaps between runs) → it is not re-classified and not duplicated. → test in Task 6.

---

## File Structure

```
package.json
.gitignore
config/rules.json          hard rules (drop categories, drop title regexes, keep categories)
config/taste.md            plain-English taste profile sent to Claude
config/examples.json       75 labeled examples [{title, decision}]
scripts/extract-examples.mjs   one-off: builds examples.json from the spec appendix
src/parseFeed.mjs          XML string → Item[]
src/rules.mjs              applyRules(item, rules)
src/store.mjs              loadStore / saveStore / mergeNew / prune
src/buildFeed.mjs          buildFeed(items, opts) → RSS XML string
src/classify.mjs           classify(items, {taste, examples, client})
src/fetchFeed.mjs          fetchFeed({fetchImpl}) → XML string
src/run.mjs                orchestration + CLI (--dry-run)
public/index.html          landing page linking both feeds
.github/workflows/feed.yml scheduled build + Pages deploy
README.md                  how it works + how to tune
test/*.test.mjs
test/fixtures/polygon-feed-2026-09-29.xml   (already present)
```

**Item shape** (used by every module):

```js
{
  guid: string,            // = link
  title: string,
  link: string,
  creator: string,         // '' if absent
  pubDate: string,         // RFC 822 string as in the feed, e.g. 'Tue, 29 Sep 2026 19:18:56 GMT'
  categories: string[],    // trimmed
  description: string,     // plain text/HTML, trimmed
  contentEncoded: string,  // HTML, trimmed; '' if absent
  enclosure: { url: string, type: string, length: string } | null,
}
```

**Stored item** = Item plus `{ decision: 'keep'|'toss'|null, reason: string, decidedBy: 'rule'|'claude'|null, firstSeen: ISO string }`.

---

### Task 1: Project scaffold + feed parser

**Files:**
- Create: `package.json`, `.gitignore`, `src/parseFeed.mjs`, `test/parseFeed.test.mjs`

**Interfaces:**
- Produces: `parseFeed(xml: string): Item[]` (named export from `src/parseFeed.mjs`).

- [ ] **Step 1: Create `package.json` and install deps**

```json
{
  "name": "polygon-filtered",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test test/",
    "build": "node src/run.mjs",
    "dry-run": "node src/run.mjs --dry-run"
  }
}
```

`.gitignore`:

```
node_modules/
.env
```

Run: `cd ~/Documents/Claude/polygon-filtered && npm install fast-xml-parser@^5 @anthropic-ai/sdk`
Expected: both appear under `dependencies` in `package.json`; `package-lock.json` created.

- [ ] **Step 2: Write the failing test** — `test/parseFeed.test.mjs`

```js
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
  assert.equal(first.title, 'Magic’s KPop Demon Hunters Secret Lair Is Coming Sooner Than You Think');
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/parseFeed.mjs'`.

- [ ] **Step 4: Implement** — `src/parseFeed.mjs`

```js
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: name => name === 'item' || name === 'category',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
});

const text = v => (v == null ? '' : String(typeof v === 'object' ? v['#text'] ?? '' : v).trim());

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('parseFeed: not an RSS feed');
  const items = channel.item ?? [];
  return items.map(raw => {
    const link = text(raw.link);
    const enc = raw.enclosure;
    return {
      guid: link,
      title: text(raw.title),
      link,
      creator: text(raw['dc:creator']),
      pubDate: text(raw.pubDate),
      categories: (raw.category ?? []).map(text).filter(Boolean),
      description: text(raw.description),
      contentEncoded: text(raw['content:encoded']),
      enclosure: enc
        ? { url: enc['@_url'] ?? '', type: enc['@_type'] ?? '', length: String(enc['@_length'] ?? '') }
        : null,
    };
  });
}
```

(The fixture has a `<pubDate>` on all 10 items — verified during planning.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/parseFeed.mjs test/parseFeed.test.mjs test/fixtures/
git commit -m "feat: project scaffold and Polygon feed parser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config files + hard rules

**Files:**
- Create: `scripts/extract-examples.mjs`, `config/examples.json` (generated), `config/rules.json`, `src/rules.mjs`, `test/rules.test.mjs`

**Interfaces:**
- Consumes: Item shape (Task 1).
- Produces: `applyRules(item: Item, rules: Rules): { decision: 'keep'|'toss'|null, reason: string }` and `loadRules(path?: string): Rules` from `src/rules.mjs`. `Rules = { dropCategories: string[], dropTitlePatterns: string[], keepCategories: string[] }`.
- Produces: `config/examples.json` = `[{ "title": string, "decision": "keep"|"toss" }]` (75 entries).

- [ ] **Step 1: Generate `config/examples.json` from the spec appendix**

`scripts/extract-examples.mjs`:

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const spec = readFileSync('docs/superpowers/specs/2026-09-29-polygon-filtered-feed-design.md', 'utf8');
const appendix = spec.split('## Appendix A')[1];
const [keepPart, tossPart] = appendix.split('\nTOSS\n');
const titles = part => part.split('\n').filter(l => l.startsWith('- ')).map(l =>
  l.slice(2).replace(/ \((relabeled[^)]*|Guides tag)\)$/, '').trim());
const examples = [
  ...titles(keepPart).map(title => ({ title, decision: 'keep' })),
  ...titles(tossPart).map(title => ({ title, decision: 'toss' })),
];
mkdirSync('config', { recursive: true });
writeFileSync('config/examples.json', JSON.stringify(examples, null, 2) + '\n');
console.log(`wrote ${examples.length} examples`);
```

Run: `node scripts/extract-examples.mjs`
Expected: `wrote 75 examples`. Spot-check: `grep -c '"keep"' config/examples.json` → `48`; `grep -c '"toss"' config/examples.json` → `27`.

- [ ] **Step 2: Create `config/rules.json`**

```json
{
  "dropCategories": ["Guides"],
  "dropTitlePatterns": [
    "\\b\\d{2,3}-Minute\\b",
    "\\b(back|returns?)\\b.{0,20}\\b(on|onto) streaming\\b",
    "\\bstreaming for free\\b",
    "\\bfree (to watch )?on YouTube\\b",
    "\\bNo\\. ?1 on (Netflix|Prime Video|HBO Max|Hulu|Disney\\+|Peacock|Paramount\\+|Apple TV)",
    "\\bleav(e|es|ing) (streaming|Netflix|Prime Video|HBO Max|Hulu|Disney\\+|Peacock|Paramount\\+)"
  ],
  "keepCategories": ["Magic: The Gathering"]
}
```

- [ ] **Step 3: Write the failing test** — `test/rules.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyRules, loadRules } from '../src/rules.mjs';

const rules = loadRules();
const examples = JSON.parse(readFileSync(new URL('../config/examples.json', import.meta.url), 'utf8'));
const item = (title, categories = []) => ({ title, categories });

const STREAMING_CLICKBAIT = [
  "Brendan Fraser's 124-Minute Action Thriller Classic Is Back From the Dead on Streaming",
  'Russell Crowe’s New Crime Thriller Is Already No. 1 on Netflix',
  "35 Years Later, the '90s Remake of a Cult Classic Thriller Is Officially Free to Watch on YouTube",
  'The Definitive ’90s Sci-Fi Action Blockbuster Is Officially Streaming for Free on YouTube',
  'Jason Statham’s 113-Minute Action Thriller Blasts Back Onto Streaming',
  'This 2014 Action Thriller Is About to Leave Netflix',
];

test('every streaming clickbait headline is tossed by rule', () => {
  for (const t of STREAMING_CLICKBAIT) {
    assert.equal(applyRules(item(t), rules).decision, 'toss', t);
  }
});

test('no labeled KEEP example is tossed by a title rule', () => {
  for (const ex of examples.filter(e => e.decision === 'keep')) {
    assert.notEqual(applyRules(item(ex.title), rules).decision, 'toss', ex.title);
  }
});

test('Guides category is tossed', () => {
  const r = applyRules(item("All paralogue dates and deadlines in Fire Emblem Fortune's Weave", ['Guides', 'Fire Emblem: Fortune\'s Weave']), rules);
  assert.equal(r.decision, 'toss');
  assert.match(r.reason, /Guides/);
});

test('Magic: The Gathering category is always kept', () => {
  const r = applyRules(item('Magic’s KPop Demon Hunters Secret Lair Is Coming Sooner Than You Think', ['News', 'Magic: The Gathering']), rules);
  assert.equal(r.decision, 'keep');
});

test('drop rules win over keep rules', () => {
  const r = applyRules(item('Every MTG Commander Deck Ranked', ['Guides', 'Magic: The Gathering']), rules);
  assert.equal(r.decision, 'toss');
});

test('category matching is case-insensitive', () => {
  assert.equal(applyRules(item('x', ['guides']), rules).decision, 'toss');
});

test('an ordinary game news item is undecided', () => {
  const r = applyRules(item('The Next Monster Hunter Game Officially Gets a Release Date', ['News', 'Monster Hunter']), rules);
  assert.deepEqual(r, { decision: null, reason: '' });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/rules.mjs'`.

- [ ] **Step 5: Implement** — `src/rules.mjs`

```js
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all rules + parseFeed tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/ config/ src/rules.mjs test/rules.test.mjs
git commit -m "feat: hard filtering rules and labeled examples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: State store

**Files:**
- Create: `src/store.mjs`, `test/store.test.mjs`

**Interfaces:**
- Consumes: Item shape.
- Produces (named exports from `src/store.mjs`):
  - `loadStore(path: string): StoredItem[]` — returns `[]` if the file doesn't exist.
  - `saveStore(path: string, items: StoredItem[]): void` — creates parent dir, writes pretty JSON + trailing newline, sorted newest-first by `pubDate`.
  - `mergeNew(stored: StoredItem[], fresh: Item[], now: Date): { all: StoredItem[], added: StoredItem[] }` — appends fresh items whose `guid` isn't already stored, with `decision: null, reason: '', decidedBy: null, firstSeen: now.toISOString()`. Existing items are left untouched.
  - `prune(items: StoredItem[], now: Date, days = 30): StoredItem[]` — drops items whose `pubDate` parses to earlier than `now - days`. Items with an unparseable `pubDate` are kept if `firstSeen` is within the window, else dropped.

- [ ] **Step 1: Write the failing test** — `test/store.test.mjs`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/store.mjs'`.

- [ ] **Step 3: Implement** — `src/store.mjs`

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs test/store.test.mjs
git commit -m "feat: item state store with merge and 30-day pruning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: RSS feed builder

**Files:**
- Create: `src/buildFeed.mjs`, `test/buildFeed.test.mjs`

**Interfaces:**
- Consumes: `parseFeed` (Task 1) in tests; StoredItem shape; `newestFirst` from `src/store.mjs` (Task 3).
- Produces: `buildFeed(items: StoredItem[], opts: { title: string, description: string, selfUrl: string, limit?: number (default 50), showReason?: boolean (default false), now?: Date }): string` from `src/buildFeed.mjs`. Items are sorted newest-first and truncated to `limit` inside the function. When `showReason` is true, each item's description is prefixed with `[Filtered: <reason>] `.

- [ ] **Step 1: Write the failing test** — `test/buildFeed.test.mjs`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/buildFeed.mjs'`.

- [ ] **Step 3: Implement** — `src/buildFeed.mjs`

```js
import { newestFirst } from './store.mjs';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const cdata = s => `<![CDATA[${String(s ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

function itemXml(item, showReason) {
  const description = showReason && item.reason ? `[Filtered: ${item.reason}] ${item.description}` : item.description;
  const parts = [
    `<title>${cdata(item.title)}</title>`,
    `<link>${esc(item.link)}</link>`,
    `<guid isPermaLink="true">${esc(item.guid)}</guid>`,
  ];
  if (item.creator) parts.push(`<dc:creator>${cdata(item.creator)}</dc:creator>`);
  if (item.pubDate) parts.push(`<pubDate>${esc(item.pubDate)}</pubDate>`);
  for (const c of item.categories ?? []) parts.push(`<category>${cdata(c)}</category>`);
  if (item.enclosure?.url) {
    parts.push(`<enclosure url="${esc(item.enclosure.url)}" length="${esc(item.enclosure.length || '0')}" type="${esc(item.enclosure.type)}"/>`);
  }
  parts.push(`<description>${cdata(description)}</description>`);
  if (item.contentEncoded) parts.push(`<content:encoded>${cdata(item.contentEncoded)}</content:encoded>`);
  return `    <item>\n      ${parts.join('\n      ')}\n    </item>`;
}

export function buildFeed(items, { title, description, selfUrl, limit = 50, showReason = false, now = new Date() }) {
  const selected = [...items].sort(newestFirst).slice(0, limit);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(title)}</title>
    <link>https://www.polygon.com</link>
    <description>${esc(description)}</description>
    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>
    <language>en-US</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
${selected.map(i => itemXml(i, showReason)).join('\n')}
  </channel>
</rss>
`;
}
```

Note: `parseFeed` sets `guid = link`, so emitting `<guid>` doesn't affect round-trips. If the "hostile characters" test fails on `link` because the parser doesn't decode `&amp;`, confirm `processEntities: true` is set in `parseFeed.mjs` (Task 1) — do not weaken the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/buildFeed.mjs test/buildFeed.test.mjs
git commit -m "feat: RSS 2.0 feed builder preserving Polygon content

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Claude classifier + taste profile

**Files:**
- Create: `config/taste.md`, `src/classify.mjs`, `test/classify.test.mjs`

**Interfaces:**
- Consumes: Item shape; `config/examples.json` (Task 2).
- Produces (named exports from `src/classify.mjs`):
  - `MODEL = 'claude-haiku-4-5'`
  - `buildRequest(items: Item[], { taste: string, examples: {title, decision}[] }): object` — the exact `messages.create` params.
  - `classify(items: Item[], { taste, examples, client }): Promise<Map<string, { decision: 'keep'|'toss', reason: string }>>` — keyed by `guid`. Returns an empty Map (never throws) if `client` is null, `items` is empty, the API call throws, `stop_reason` isn't `end_turn`, or JSON is unparsable. Ignores ids not in `items` and decisions other than `keep`/`toss`.
  - `loadTaste(): string`, `loadExamples(): {title, decision}[]` — read from `config/`.

`client` is anything with `messages.create(params) → Promise<{ stop_reason, content: [{type:'text', text}] }>` — the real `Anthropic` instance in production, a fake in tests.

- [ ] **Step 1: Create `config/taste.md`**

```markdown
# Steven's Polygon taste

I read Polygon for video games first, plus a few adjacent hobbies. Keep an article
if I'd plausibly click it; toss it if it's filler.

## Keep
- Video game news, announcements, release dates, updates, business/industry news.
- Game reviews, impressions, analysis, opinion essays, and features about games
  (including "why this game works" pieces and recommendations of specific games).
- Horror anything — horror games, horror movies, horror TV (e.g. Mike Flanagan,
  The Exorcist, Backrooms).
- Notable film/TV news with real substance: prestige or genuinely anticipated
  projects (Game of Thrones, The Mummy 4, a del Toro project), and film reviews.
- Game-to-film/TV adaptation news.
- Lego sets and news.
- Magic: The Gathering (I play it).

## Toss
- Walkthroughs, guides, "how to find/unlock", date/deadline lists, tier lists.
- Streaming clickbait: "This 124-minute action thriller is back on streaming",
  "No. 1 on Netflix", "free to watch on YouTube", "about to leave streaming".
- Big-franchise churn: Marvel/Avengers/Spider-Man, DC/Green Lantern/Lanterns,
  Star Wars — casting, set gossip, "fans are furious", ending explainers.
- Anime news (Naruto, Dragon Ball, etc.) and manga previews.
- Pokémon trading-card retail/restock/scalper/Happy Meal stories (Pokémon video
  games are fine).
- Nostalgia retrospectives ("29 years ago, Buffy…") and "N years later, old
  thing is suddenly popular again" pieces. A genuine new sequel announcement is
  still a keep even if the headline says "30 years later".
- Generic TV renewals and animated-series news (Reacher, Futurama, Avatar series).
- Graphic-novel excerpts and book promos.

When unsure between keep and toss for a video-game article, keep it. When unsure
for a non-game film/TV article, toss it unless it's horror.
```

- [ ] **Step 2: Write the failing test** — `test/classify.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildRequest, MODEL, loadTaste, loadExamples } from '../src/classify.mjs';

const items = [
  { guid: 'https://www.polygon.com/a/', title: 'Monster Hunter Gets a Release Date', categories: ['News'], description: 'd1' },
  { guid: 'https://www.polygon.com/b/', title: 'Avengers Hulk Fate', categories: ['Movies'], description: 'd2' },
];
const taste = loadTaste();
const examples = loadExamples();

const fakeClient = (responder) => {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return responder(params); } } };
};
const reply = (obj, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('request uses Haiku, includes taste, examples, and every item', () => {
  const req = buildRequest(items, { taste, examples });
  assert.equal(req.model, MODEL);
  assert.equal(MODEL, 'claude-haiku-4-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  const system = JSON.stringify(req.system);
  assert.match(system, /Steven's Polygon taste/);
  assert.match(system, /Avengers: Doomsday Directors Confirm Hulk/);
  const user = JSON.stringify(req.messages);
  assert.match(user, /polygon\.com\/a\//);
  assert.match(user, /Avengers Hulk Fate/);
});

test('maps decisions back to guids', async () => {
  const client = fakeClient(() => reply({ decisions: [
    { id: 'https://www.polygon.com/a/', decision: 'keep', reason: 'game news' },
    { id: 'https://www.polygon.com/b/', decision: 'toss', reason: 'Marvel churn' },
  ] }));
  const out = await classify(items, { taste, examples, client });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(out.get('https://www.polygon.com/a/'), { decision: 'keep', reason: 'game news' });
  assert.deepEqual(out.get('https://www.polygon.com/b/'), { decision: 'toss', reason: 'Marvel churn' });
});

test('partial answers: unknown ids and bad decisions are ignored, missing stay absent', async () => {
  const client = fakeClient(() => reply({ decisions: [
    { id: 'https://www.polygon.com/a/', decision: 'keep', reason: 'ok' },
    { id: 'https://evil/', decision: 'keep', reason: 'x' },
    { id: 'https://www.polygon.com/b/', decision: 'maybe', reason: 'x' },
  ] }));
  const out = await classify(items, { taste, examples, client });
  assert.deepEqual([...out.keys()], ['https://www.polygon.com/a/']);
});

test('garbage JSON → empty map, no throw', async () => {
  const client = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }));
  assert.equal((await classify(items, { taste, examples, client })).size, 0);
});

test('non end_turn stop reason → empty map', async () => {
  const client = fakeClient(() => reply({ decisions: [] }, 'max_tokens'));
  assert.equal((await classify(items, { taste, examples, client })).size, 0);
});

test('API error → empty map, no throw', async () => {
  const client = fakeClient(() => { throw new Error('529 overloaded'); });
  assert.equal((await classify(items, { taste, examples, client })).size, 0);
});

test('null client or no items → empty map without calling anything', async () => {
  assert.equal((await classify(items, { taste, examples, client: null })).size, 0);
  const client = fakeClient(() => reply({ decisions: [] }));
  assert.equal((await classify([], { taste, examples, client })).size, 0);
  assert.equal(client.calls.length, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/classify.mjs'`.

- [ ] **Step 4: Implement** — `src/classify.mjs`

```js
import { readFileSync } from 'node:fs';

export const MODEL = 'claude-haiku-4-5';

export const loadTaste = () => readFileSync(new URL('../config/taste.md', import.meta.url), 'utf8');
export const loadExamples = () => JSON.parse(readFileSync(new URL('../config/examples.json', import.meta.url), 'utf8'));

const SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['keep', 'toss'] },
          reason: { type: 'string' },
        },
        required: ['id', 'decision', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
};

export function buildRequest(items, { taste, examples }) {
  const exampleLines = examples.map(e => `${e.decision.toUpperCase()}: ${e.title}`).join('\n');
  const system = `You filter a personal RSS feed of Polygon.com articles for one reader.
Decide "keep" or "toss" for each article using the reader's taste profile and their
own past decisions below. Give a short reason (under 12 words) for each.

<taste_profile>
${taste}
</taste_profile>

<past_decisions>
${exampleLines}
</past_decisions>`;

  const payload = items.map(i => ({
    id: i.guid,
    title: i.title,
    tags: i.categories,
    summary: (i.description ?? '').slice(0, 400),
  }));

  return {
    model: MODEL,
    max_tokens: 4096,
    system,
    messages: [{
      role: 'user',
      content: `Classify every article below. Return one decision per id.\n\n${JSON.stringify(payload, null, 2)}`,
    }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };
}

export async function classify(items, { taste, examples, client }) {
  const out = new Map();
  if (!client || items.length === 0) return out;
  const ids = new Set(items.map(i => i.guid));
  try {
    const res = await client.messages.create(buildRequest(items, { taste, examples }));
    if (res.stop_reason !== 'end_turn') {
      console.error(`classify: unexpected stop_reason ${res.stop_reason}; leaving items pending`);
      return out;
    }
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const { decisions } = JSON.parse(text);
    for (const d of decisions ?? []) {
      if (ids.has(d.id) && (d.decision === 'keep' || d.decision === 'toss')) {
        out.set(d.id, { decision: d.decision, reason: String(d.reason ?? '') });
      }
    }
  } catch (err) {
    console.error(`classify: ${err.message}; leaving items pending`);
    return new Map();
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/taste.md src/classify.mjs test/classify.test.mjs
git commit -m "feat: Claude Haiku classifier with taste profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Fetcher + orchestrator + CLI

**Files:**
- Create: `src/fetchFeed.mjs`, `src/run.mjs`, `public/index.html`, `test/run.test.mjs`

**Interfaces:**
- Consumes: `parseFeed` (T1); `applyRules`, `loadRules` (T2); `loadStore`, `saveStore`, `mergeNew`, `prune` (T3); `buildFeed` (T4); `classify`, `loadTaste`, `loadExamples` (T5).
- Produces:
  - `fetchFeed({ fetchImpl = fetch, url = FEED_URL, attempts = 4, delayMs = 2000 } = {}): Promise<string>` from `src/fetchFeed.mjs`; throws after the last failed attempt. Treats non-2xx and bodies without `<rss` as failures.
  - `run({ fetchImpl, client, now = new Date(), dryRun = false, root = <repo root URL> }): Promise<{ added: number, pending: number, kept: number, tossed: number }>` from `src/run.mjs`. `root` is a directory path string; state at `<root>/data/items.json`, outputs at `<root>/public/feed.xml` and `<root>/public/rejected.xml`.

- [ ] **Step 1: Write the failing test** — `test/run.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/run.mjs'`.

- [ ] **Step 3: Implement** — `src/fetchFeed.mjs`

```js
export const FEED_URL = 'https://www.polygon.com/feed/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 polygon-filtered';

export async function fetchFeed({ fetchImpl = fetch, url = FEED_URL, attempts = 4, delayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!body.includes('<rss')) throw new Error('response is not an RSS feed');
      return body;
    } catch (err) {
      lastErr = err;
      console.error(`fetchFeed attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts && delayMs > 0) await new Promise(r => setTimeout(r, delayMs * i));
    }
  }
  throw new Error(`fetchFeed: giving up: ${lastErr?.message}`);
}
```

- [ ] **Step 4: Implement** — `src/run.mjs`

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeed } from './fetchFeed.mjs';
import { parseFeed } from './parseFeed.mjs';
import { applyRules, loadRules } from './rules.mjs';
import { loadStore, saveStore, mergeNew, prune } from './store.mjs';
import { classify, loadTaste, loadExamples } from './classify.mjs';
import { buildFeed } from './buildFeed.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = 'https://tartick.github.io/polygon-filtered';

export async function run({ fetchImpl = fetch, client = null, now = new Date(), dryRun = false, root = REPO_ROOT, fetchOpts = {} } = {}) {
  const statePath = join(root, 'data', 'items.json');
  const fresh = parseFeed(await fetchFeed({ fetchImpl, ...fetchOpts }));

  const { all, added } = mergeNew(loadStore(statePath), fresh, now);
  const items = prune(all, now);

  const rules = loadRules();
  for (const item of items.filter(i => i.decision === null)) {
    const r = applyRules(item, rules);
    if (r.decision) Object.assign(item, { decision: r.decision, reason: r.reason, decidedBy: 'rule' });
  }

  const pending = items.filter(i => i.decision === null);
  if (pending.length && !client) console.error(`No ANTHROPIC_API_KEY; ${pending.length} item(s) left pending`);
  const verdicts = await classify(pending, { taste: loadTaste(), examples: loadExamples(), client });
  for (const item of pending) {
    const v = verdicts.get(item.guid);
    if (v) Object.assign(item, { decision: v.decision, reason: v.reason, decidedBy: 'claude' });
  }

  const kept = items.filter(i => i.decision === 'keep');
  const tossed = items.filter(i => i.decision === 'toss');
  const summary = { added: added.length, pending: items.filter(i => i.decision === null).length, kept: kept.length, tossed: tossed.length };

  for (const i of added) console.log(`${(i.decision ?? 'PENDING').toUpperCase().padEnd(7)} ${i.title}  — ${i.reason}`);
  console.log(JSON.stringify(summary));
  if (dryRun) return summary;

  saveStore(statePath, items);
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', 'feed.xml'), buildFeed(kept, {
    title: 'Polygon (filtered)', description: 'Polygon.com minus the shovelware.', selfUrl: `${SITE}/feed.xml`, now,
  }));
  writeFileSync(join(root, 'public', 'rejected.xml'), buildFeed(tossed, {
    title: 'Polygon (filtered out)', description: 'Articles the Polygon filter tossed, with reasons.', selfUrl: `${SITE}/rejected.xml`, showReason: true, now,
  }));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  run({ client, dryRun: process.argv.includes('--dry-run') }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Polygon Filtered</title>
  <link rel="alternate" type="application/rss+xml" title="Polygon (filtered)" href="feed.xml">
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; }
  </style>
</head>
<body>
  <h1>Polygon, filtered</h1>
  <p>Polygon.com's RSS feed minus streaming clickbait, guides, and franchise churn.</p>
  <ul>
    <li><a href="feed.xml">feed.xml</a> — the good stuff</li>
    <li><a href="rejected.xml">rejected.xml</a> — what got filtered, and why</li>
  </ul>
</body>
</html>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 7: Offline smoke run against the live feed with no key**

Run: `env -u ANTHROPIC_API_KEY node src/run.mjs --dry-run`
Expected: prints one line per current Polygon item (rule-decided ones show KEEP/TOSS with `Rule:` reasons, others `PENDING`), then a JSON summary; exit code 0; `git status` shows no new files under `data/` or `public/` except `public/index.html`.

- [ ] **Step 8: Commit**

```bash
git add src/fetchFeed.mjs src/run.mjs public/index.html test/run.test.mjs
git commit -m "feat: fetch with retries, orchestration, and dry-run CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: GitHub Actions workflow, README, publish

**Files:**
- Create: `.github/workflows/feed.yml`, `README.md`

**Interfaces:**
- Consumes: `npm test`, `node src/run.mjs` (Task 6).
- Produces: public repo `tartick/polygon-filtered` with Pages (build type: workflow) serving `public/`.

- [ ] **Step 1: Create `.github/workflows/feed.yml`**

```yaml
name: Build filtered feed

on:
  schedule:
    - cron: '7,37 * * * *'
  workflow_dispatch:

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: feed
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
      - name: Filter feed
        run: node src/run.mjs
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Commit state and feeds
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data public
          if git diff --cached --quiet; then
            echo "No changes"
          else
            git commit -m "Update filtered feed"
            git push
          fi
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with:
          path: public
      - id: deploy
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Create `README.md`**

```markdown
# polygon-filtered

Polygon.com's RSS feed, minus the shovelware.

- **Subscribe:** https://tartick.github.io/polygon-filtered/feed.xml
- **Audit what got filtered:** https://tartick.github.io/polygon-filtered/rejected.xml

## How it works

Every 30 minutes a GitHub Action fetches https://www.polygon.com/feed/ (it only
ever holds the 10 newest articles), and for each article it hasn't seen before:

1. **Hard rules** (`config/rules.json`) — drops anything tagged `Guides` and
   streaming-clickbait headlines; always keeps `Magic: The Gathering`.
2. **Claude Haiku** judges everything else against `config/taste.md` and the
   labeled examples in `config/examples.json`.

Decisions are stored in `data/items.json` (30 days), and the kept / tossed
articles are published to GitHub Pages.

## Tuning

- Wrong call? Add the headline to `config/examples.json` with the right
  `decision`, or adjust `config/taste.md`, then commit and push.
- Past decisions aren't re-judged. To re-judge an article, set its `decision`
  to `null` in `data/items.json`.

## Local use

    npm install
    npm test
    ANTHROPIC_API_KEY=... npm run dry-run   # print decisions, write nothing
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/feed.yml README.md
git commit -m "ci: scheduled feed build and GitHub Pages deploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Create the public repo, push, and enable Pages via Actions**

```bash
cd ~/Documents/Claude/polygon-filtered
gh repo create tartick/polygon-filtered --public --source . --push --description "Polygon.com RSS minus the shovelware"
gh api -X POST repos/tartick/polygon-filtered/pages -f build_type=workflow
```

Expected: repo URL printed; Pages API returns JSON with `"build_type": "workflow"` (a 409 "already exists" is also fine).

- [ ] **Step 5: Trigger one run and verify**

```bash
gh workflow run feed.yml --repo tartick/polygon-filtered
sleep 15
gh run list --repo tartick/polygon-filtered --limit 1
gh run watch --repo tartick/polygon-filtered $(gh run list --repo tartick/polygon-filtered --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
curl -sS https://tartick.github.io/polygon-filtered/feed.xml | head -20
```

Expected: run succeeds (without the API key, Claude items stay pending and the log says `No ANTHROPIC_API_KEY`); `feed.xml` is served with `<title>Polygon (filtered)</title>` and at least the rule-kept items. Pages may take a minute on first deploy — retry the curl if it 404s.

---

## After implementation (Steven's manual step)

1. Create a key at console.anthropic.com → API Keys.
2. `gh secret set ANTHROPIC_API_KEY --repo tartick/polygon-filtered` and paste at the prompt.
3. `gh workflow run feed.yml --repo tartick/polygon-filtered` to classify the pending items.
4. Subscribe to `https://tartick.github.io/polygon-filtered/feed.xml`.
