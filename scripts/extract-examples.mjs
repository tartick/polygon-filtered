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
