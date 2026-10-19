import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBlock } from './load-block.mjs';

const session = loadBlock('grill-session', 'GrillSession');
const src = 'https://example.com/image?id=42';
const question = { id: 'q1', status: 'asking', options: [{ id: 'a' }] };

test('a decoded extensionless URL becomes an option picture without a kind field', () => {
  const raw = { questions: [question], refs: [{ id: 'r1', src: ' ' + src + ' ', target: 'q1:a' }] };
  const before = session.model(raw);
  assert.deepEqual(before.boardRefs.map(ref => ref.id), ['r1']);
  assert.deepEqual(before.optionPictures, []);
  const after = session.model(raw, {}, { imageSources: new Set([src]) });
  assert.deepEqual(after.optionPictures.map(ref => [ref.id, ref.src, ref.kind]), [['r1', src, 'image']]);
  assert.equal(after.questionsById.q1.optionPictures.a.id, 'r1');
  assert.deepEqual(after.boardRefs, []);
  assert.equal(raw.refs[0].kind, undefined);
});

test('decoded images work on the board and user options while explicit links remain links', () => {
  const model = session.model({ questions: [question], refs: [
    { id: 'r1', src, target: 'idea' }, { id: 'r2', src, kind: 'link', target: 'q1:a' }
  ] }, { refs: [{ id: 'u1', src, target: 'q1:a' }] }, { imageSources: new Set([src]) });
  assert.deepEqual(model.boardRefs.map(ref => [ref.id, ref.kind, session.isPicture(ref)]),
    [['r1', 'image', true], ['r2', 'link', false]]);
  assert.deepEqual(model.optionPictures.map(ref => ref.nodeId), ['ref:user:u1']);
});
