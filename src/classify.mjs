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
