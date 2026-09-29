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
