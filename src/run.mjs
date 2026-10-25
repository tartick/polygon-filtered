import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeed } from './fetchFeed.mjs';
import { parseFeed } from './parseFeed.mjs';
import { applyRules, loadRules } from './rules.mjs';
import { loadStore, saveStore, mergeNew, prune } from './store.mjs';
import { classify, loadTaste, loadExamples } from './classify.mjs';
import { maybeAddDigest, pruneDigests, loadDigests, saveDigests } from './digest.mjs';
import { buildFeed } from './buildFeed.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLASSIFY_CHUNK = 20;
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
  const taste = loadTaste();
  const examples = loadExamples();
  const verdicts = new Map();
  for (let i = 0; i < pending.length; i += CLASSIFY_CHUNK) {
    const part = await classify(pending.slice(i, i + CLASSIFY_CHUNK), { taste, examples, client });
    for (const [guid, v] of part) verdicts.set(guid, v);
  }
  for (const item of pending) {
    const v = verdicts.get(item.guid);
    if (v) Object.assign(item, { decision: v.decision, reason: v.reason, decidedBy: 'claude' });
  }

  const kept = items.filter(i => i.decision === 'keep');
  const tossed = items.filter(i => i.decision === 'toss');
  const digestPath = join(root, 'data', 'digests.json');
  const { digests, added: digest } = maybeAddDigest({ items, digests: pruneDigests(loadDigests(digestPath), now), now, site: SITE });
  if (digest) console.log(`DIGEST  ${digest.title} (${digest.guids.length} item(s))`);

  const summary = { added: added.length, pending: items.filter(i => i.decision === null).length, kept: kept.length, tossed: tossed.length, digest: digest ? digest.title : null };

  for (const i of added) console.log(`${(i.decision ?? 'PENDING').toUpperCase().padEnd(7)} ${i.title}  — ${i.reason}`);
  console.log(JSON.stringify(summary));
  if (dryRun) return summary;

  saveStore(statePath, items);
  saveDigests(digestPath, digests);
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', 'feed.xml'), buildFeed([...kept, ...digests], {
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
