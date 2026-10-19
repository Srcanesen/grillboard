import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBlock } from './load-block.mjs';

const session = loadBlock('grill-session', 'GrillSession');

test('omitted entries are skipped throughout session and user lists', () => {
  const raw = {
    architecture: [, 'Use SQLite'],
    questions: [, { id: 'q1', status: 'asking', dependsOn: [, 'q2'], options: [, { id: 'a', label: 'Files' }] },
      { id: 'q2', status: 'settled' }],
    refs: [, { id: 'r1', src: 'refs/a.svg', target: 'q1:a' }],
    sketches: [, { id: 'k1', src: 'sketch/home.html' }],
    research: [, { id: 's1', status: 'done', report: 'research/s1.md', sources: [, { url: 'https://example.com' }] }]
  };
  const user = {
    refs: [, { id: 'u1', src: 'https://example.com' }],
    answers: [, { id: 'a1', items: [, { question: 'q1', option: 'a', text: '' }] }]
  };
  const model = session.model(raw, user);
  assert.deepEqual(model.architecture, ['Use SQLite']);
  assert.deepEqual(model.questions.map(q => q.id), ['q1', 'q2']);
  assert.deepEqual(model.questionsById.q1.validDependencies, ['q2']);
  assert.deepEqual(model.questionsById.q1.options.map(o => [o.id, o.label]), [['a', 'Files']]);
  assert.deepEqual(model.optionPictures.map(ref => ref.nodeId), ['ref:agent:r1']);
  assert.deepEqual(model.boardRefs.map(ref => ref.nodeId), ['ref:user:u1']);
  assert.deepEqual(model.boardSketches.map(sketch => sketch.id), ['k1']);
  assert.deepEqual(model.boardReports.map(note => [note.id, note.sources]),
    [['s1', [{ title: '', url: 'https://example.com' }]]]);
  assert.equal(model.pendingCount, 1);
  assert.deepEqual(model.questionsById.q1.pendingItem, { question: 'q1', option: 'a', text: '' });
  assert.equal(raw.refs.length, 2);
  assert.equal(0 in raw.refs, false);
});

test('all-hole lists normalize to empty collections', () => {
  const model = session.model({ refs: Array(2), research: Array(2), sketches: Array(2), questions: Array(2) },
    { refs: Array(2), answers: Array(2) });
  assert.deepEqual([model.refs, model.research, model.sketches, model.questions, model.userRefs], [[], [], [], [], []]);
  assert.equal(model.pendingCount, 0);
});
