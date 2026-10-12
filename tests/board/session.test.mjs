import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadBlock } from './load-block.mjs';

const session = loadBlock('grill-session', 'GrillSession');

test('empty session has the documented defaults and empty derived collections', () => {
  assert.deepEqual(session.model({}, {}), {
    lang: '', title: '', idea: '', answered: '', status: '', labels: {}, refs: [], sketches: [], architecture: [], research: [], questions: [],
    userRefs: [], questionsByStatus: { settled: [], asking: [], researching: [], waiting: [] }, questionsById: {}, openQuestions: [],
    researchByStatus: { todo: [], running: [], done: [] }, unfinishedResearch: [], pendingCount: 0
  });
});

test('missing and malformed fields normalize without losing numeric ids', () => {
  const model = session.model({ lang: null, labels: [], refs: false, architecture: 'bad', sketches: [{}], research: [{}],
    questions: [{ id: 7, status: 'wrong', options: {}, round: 'not a number' }, {}] }, { refs: [{}] });
  assert.deepEqual(model.questions, [
    { id: '7', round: '', title: '', body: '', status: 'waiting', reopened: false, dependsOn: [], options: [], recommended: null,
      recommendation: '', decision: '', answer: { option: null, text: '' }, pending: false, pendingItem: null },
    { id: '', round: '', title: '', body: '', status: 'waiting', reopened: false, dependsOn: [], options: [], recommended: null,
      recommendation: '', decision: '', answer: { option: null, text: '' }, pending: false, pendingItem: null }
  ]);
  assert.deepEqual(model.sketches, [{ id: '', title: '', src: '', rev: 0, width: 1280, height: 800, note: '' }]);
  assert.deepEqual(model.research, [{ id: '', target: '', parsedTarget: { questionId: '', optionId: '' }, topic: '', status: 'todo', finding: '', report: '', sources: [] }]);
  assert.deepEqual(model.userRefs, [{ id: '', src: '', target: '', parsedTarget: { questionId: '', optionId: '' }, caption: '', note: '', name: '', kind: '', user: true }]);
  assert.deepEqual([model.lang, model.labels, model.refs, model.architecture], ['', {}, [], []]);
});

test('normalization bounds sketches, cleans sources and parses every target', () => {
  const model = session.model({ questions: [{ id: 'q2', status: 'asking', round: '2', options: [{ id: 3, width: 5, height: 5000 }], answer: { option: 3, text: true } }],
    refs: [{ id: 'r1', target: 'q2:a' }], research: [{ id: 's1', target: 'q2:a', status: 'done', sources: [
      { title: 'Safe', url: ' https://example.com/page ' }, { url: 'javascript:bad' }, { url: '/relative' } ] }] }, { refs: [{ target: 'idea' }] });
  assert.deepEqual(model.questions[0].options, [{ id: '3', label: '', sketch: '', width: 200, height: 4000 }]);
  assert.deepEqual(model.questions[0].answer, { option: '3', text: 'true' });
  assert.equal(model.questions[0].round, 2);
  assert.deepEqual(model.refs[0].parsedTarget, { questionId: 'q2', optionId: 'a' });
  assert.deepEqual(model.userRefs[0].parsedTarget, { questionId: 'idea', optionId: '' });
  assert.equal(model.research[0].target, 'q2');
  assert.deepEqual(model.research[0].parsedTarget, { questionId: 'q2', optionId: 'a' });
  assert.deepEqual(model.research[0].sources, [{ title: 'Safe', url: 'https://example.com/page' }]);
});

const item = { question: 'q2', option: 'a', text: '' };
const laterItem = { question: 'q2', option: null, text: 'Later answer' };
const batch = (id, answer = item) => ({ id, items: [answer] });
const pendingCases = [
  ['no batches', {}, {}, {}, false, null, 0],
  ['one batch', {}, { answers: [batch('a1')] }, {}, true, { question: 'q2', option: 'a', text: '' }, 1],
  ['equal to answered', { answered: 'a2' }, { answers: [batch('a2')] }, {}, false, null, 0],
  ['older than answered', { answered: 'a2' }, { answers: [batch('a1')] }, {}, false, null, 0],
  ['later number wins regardless of file order', {}, { answers: [batch('a3', laterItem), batch('a2')] }, {}, true, { question: 'q2', option: null, text: 'Later answer' }, 1],
  ['settled question', { questionStatus: 'settled' }, { answers: [batch('a1')] }, {}, false, null, 0],
  ['disk mode', {}, { answers: [batch('a1')] }, { serverMode: false }, false, null, 0],
  ['invalid batch ids', {}, { answers: [batch('answer1'), batch('a0'), batch('a01'), batch('a-1'), batch('a1x')] }, {}, false, null, 0],
  ['invalid answered means zero', { answered: 'not-a-batch' }, { answers: [batch('a1')] }, {}, true, { question: 'q2', option: 'a', text: '' }, 1]
];
for (const [name, raw, user, options, pending, pendingItem, count] of pendingCases) {
  test('pending: ' + name, () => {
    const model = session.model({ ...raw, questions: [{ id: 'q2', status: raw.questionStatus || 'asking' }] }, user, options);
    assert.deepEqual({ pending: model.questions[0].pending, item: model.questions[0].pendingItem, count: model.pendingCount },
      { pending, item: pendingItem, count });
  });
}

test('status groups and id lookup expose normalized questions in original order', () => {
  const model = session.model({ questions: [{ id: 'q3', status: 'waiting' }, { id: 'q1', status: 'settled' }, { id: 'q2', status: 'asking' }, { id: 'q4', status: 'researching' }] });
  assert.deepEqual(Object.fromEntries(Object.entries(model.questionsByStatus).map(([status, questions]) => [status, questions.map(q => q.id)])),
    { settled: ['q1'], asking: ['q2'], researching: ['q4'], waiting: ['q3'] });
  assert.deepEqual(model.openQuestions.map(q => q.id), ['q3', 'q2', 'q4']);
  assert.equal(model.questionsById.q2.status, 'asking');
});

for (const [target, expected] of [
  ['', { questionId: '', optionId: '' }], ['idea', { questionId: 'idea', optionId: '' }],
  ['q2', { questionId: 'q2', optionId: '' }], ['q2:a', { questionId: 'q2', optionId: 'a' }]
]) test('parseTarget: ' + JSON.stringify(target), () => assert.deepEqual(session.parseTarget(target), expected));

for (const [answer, expected] of [
  [{ option: 'a', text: '' }, true], [{ option: null, text: ' \n\t ' }, false], [{ option: null, text: 'My answer' }, true], [null, false]
]) test('hasAnswer: ' + JSON.stringify(answer), () => assert.equal(session.hasAnswer(answer), expected));

test('answer limit, batch numbers and question numbers retain their contract', () => {
  assert.equal(session.ANSWER_TEXT_MAX, 2000);
  assert.deepEqual(['a1', 'a12', 'a0', 'a01', 'wrong', ''].map(session.batchNumber), [1, 12, 0, 0, 0, 0]);
  assert.deepEqual(['q2', 'Q02', 'custom', ''].map(session.questionNumber), ['2', '02', '', '']);
});

for (const [kind, id, expected] of [
  ['idea', '', '@idea'], ['question', 'q2', 'q2'], ['ref:user', 'u1', 'ref:user:u1'], ['ref:agent', 'r1', 'ref:agent:r1'],
  ['research', 's1', 'research:s1'], ['report', 's1', 'report:s1'], ['sketch', 'k1', 'sketch:k1']
]) test('node ids: ' + kind, () => {
  assert.equal(session.nodeId(kind, id), expected);
  assert.deepEqual(session.parseNodeId(expected), { kind, id });
});

test('report matches its research note by metadata or by parsed node id', () => {
  const note = { id: session.nodeId('research', 's1'), noteId: 's1' };
  const report = { id: session.nodeId('report', 's1'), noteId: 's1' };
  assert.equal(report.noteId === note.noteId, true);
  assert.equal(session.parseNodeId(report.id).id === session.parseNodeId(note.id).id, true);
  assert.equal(session.parseNodeId('report:s2').id === session.parseNodeId(note.id).id, false);
});

function readAssignment(code, name) {
  const globals = {};
  new Function('window', code)(globals);
  return globals[name];
}

test('the skill session example has the documented question ids and statuses', () => {
  const skill = readFileSync(new URL('../../skills/grillboard/SKILL.md', import.meta.url), 'utf8');
  const code = /```js\n([\s\S]*?)```/.exec(skill)[1];
  const model = session.model(readAssignment(code, '__GRILL__'), {});
  assert.deepEqual(model.questions.map(q => [q.id, q.status]), [['q1', 'settled'], ['q2', 'asking']]);
});

test('the demo session and user files have the documented question ids and statuses', () => {
  const read = file => readFileSync(new URL('../../examples/demo/' + file, import.meta.url), 'utf8');
  const model = session.model(readAssignment(read('session.js'), '__GRILL__'), readAssignment(read('user.js'), '__GRILL_USER__'));
  assert.deepEqual(model.questions.map(q => [q.id, q.status]), [
    ['q1', 'settled'], ['q2', 'settled'], ['q3', 'settled'], ['q4', 'asking'], ['q5', 'asking'], ['q6', 'researching'], ['q8', 'asking'], ['q7', 'waiting']
  ]);
  assert.deepEqual(model.userRefs.map(ref => [ref.id, ref.target]), [['u1', 'q3'], ['u2', '']]);
  assert.equal(model.pendingCount, 0);
});

test('shared page value helpers retain defaults and coercion', () => {
  assert.deepEqual([session.object(null), session.object([]), session.object({ title: 'Title' })], [{}, {}, { title: 'Title' }]);
  assert.deepEqual([session.string(null), session.string(7), session.string(false), session.string('Text')], ['', '7', 'false', 'Text']);
  assert.deepEqual([session.array(null), session.array({}), session.array(['q2'])], [[], [], ['q2']]);
});

test('shared URL helper allows only complete HTTP(S) URLs', () => {
  assert.deepEqual([' https://example.com/page ', 'http://example.com', '/relative', 'javascript:alert(1)', 'https://bad url'].map(session.singleWebUrl),
    ['https://example.com/page', 'http://example.com', '', '', '']);
});

test('node parsing preserves suffixes and unknown node kinds are rejected', () => {
  assert.equal(session.nodeId('report', 's1:detail'), 'report:s1:detail');
  assert.deepEqual(session.parseNodeId('report:s1:detail'), { kind: 'report', id: 's1:detail' });
  assert.throws(() => session.nodeId('unknown', 's1'), { message: 'Unknown board node kind: unknown' });
});
