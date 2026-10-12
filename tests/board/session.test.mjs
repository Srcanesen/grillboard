import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadBlock } from './load-block.mjs';

const session = loadBlock('grill-session', 'GrillSession');

test('empty session has the documented defaults and empty derived collections', () => {
  assert.deepEqual(session.model({}, {}), {
    lang: '', title: '', idea: '', answered: '', status: '', labels: {}, refs: [], sketches: [], architecture: [], research: [], questions: [],
    ideaNodeId: '@idea', userRefs: [], boardRefs: [], boardSketches: [], boardReports: [], optionPictures: [], questionsByStatus: { settled: [], asking: [], researching: [], waiting: [] }, questionsById: {}, openQuestions: [],
    researchByStatus: { todo: [], running: [], done: [] }, boardResearch: [], unfinishedResearch: [], pendingCount: 0
  });
});

test('missing and malformed fields normalize without losing numeric ids', () => {
  const model = session.model({ lang: null, labels: [], refs: false, architecture: 'bad', sketches: [{}], research: [{}],
    questions: [{ id: 7, status: 'wrong', options: {}, round: 'not a number' }, {}] }, { refs: [{}] });
  assert.deepEqual(model.questions, [
    { id: '7', round: '', title: '', body: '', status: 'waiting', reopened: false, dependsOn: [], options: [], recommended: null,
      recommendation: '', decision: '', answer: { option: null, text: '' }, validDependencies: [], research: [], optionPictures: {}, pending: false, pendingItem: null },
    { id: '', round: '', title: '', body: '', status: 'waiting', reopened: false, dependsOn: [], options: [], recommended: null,
      recommendation: '', decision: '', answer: { option: null, text: '' }, validDependencies: [],
      research: [{ id: '', nodeId: 'research:', reportNodeId: 'report:', target: '', parsedTarget: { questionId: '', optionId: '' }, topic: '', status: 'todo', finding: '', report: '', sources: [] }],
      optionPictures: {}, pending: false, pendingItem: null }
  ]);
  assert.deepEqual(model.sketches, [{ id: '', nodeId: 'sketch:', title: '', src: '', rev: 0, width: 1280, height: 800, note: '' }]);
  assert.deepEqual(model.research, [{ id: '', nodeId: 'research:', reportNodeId: 'report:', target: '', parsedTarget: { questionId: '', optionId: '' }, topic: '', status: 'todo', finding: '', report: '', sources: [] }]);
  assert.deepEqual(model.userRefs, [{ id: '', nodeId: 'ref:user:', src: '', target: '', parsedTarget: { questionId: '', optionId: '' }, caption: '', note: '', name: '', kind: '', user: true }]);
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
  assert.equal(model.refs[0].target, 'q2:a');
  assert.deepEqual(model.userRefs[0].parsedTarget, { questionId: 'idea', optionId: '' });
  assert.equal(model.research[0].target, 'q2:a');
  assert.deepEqual(model.research[0].parsedTarget, { questionId: 'q2', optionId: 'a' });
  assert.deepEqual(model.research[0].sources, [{ title: 'Safe', url: 'https://example.com/page' }]);
});

test('the model names the board nodes and keeps only sketches and reports with a usable source', () => {
  const model = session.model({ sketches: [{ id: 'k1', src: 'sketches/k1.html' }, { id: 'k2', src: 'javascript:bad' }, { id: 'k3' }],
    research: [{ id: 's1', status: 'done', report: 'research/s1.html' }, { id: 's2', status: 'done', report: 'javascript:bad' },
      { id: 's3', status: 'running', report: 'research/s3.html' }] }, {}, { baseUrl: 'http://127.0.0.1:4181/' });
  assert.equal(model.ideaNodeId, '@idea');
  assert.deepEqual(model.sketches.map(sketch => sketch.nodeId), ['sketch:k1', 'sketch:k2', 'sketch:k3']);
  assert.deepEqual(model.research.map(note => [note.nodeId, note.reportNodeId]),
    [['research:s1', 'report:s1'], ['research:s2', 'report:s2'], ['research:s3', 'report:s3']]);
  assert.deepEqual(model.boardSketches.map(sketch => sketch.nodeId), ['sketch:k1']);
  assert.deepEqual(model.boardReports.map(note => note.reportNodeId), ['report:s1']);
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
  ['batch numbers compare numerically across digits', { answered: 'a2' }, { answers: [batch('a12', laterItem), batch('a3')] }, {}, true, { question: 'q2', option: null, text: 'Later answer' }, 1],
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

test('answer limit and question numbers retain their contract', () => {
  assert.equal(session.ANSWER_TEXT_MAX, 2000);
  assert.deepEqual(['q2', 'Q02', 'custom', ''].map(session.questionNumber), ['2', '02', '', '']);
});

for (const [kind, id, expected] of [
  ['idea', '', '@idea'], ['question', 'q2', 'q2'], ['ref:user', 'u1', 'ref:user:u1'], ['ref:agent', 'r1', 'ref:agent:r1'],
  ['research', 's1', 'research:s1'], ['report', 's1', 'report:s1'], ['sketch', 'k1', 'sketch:k1']
]) test('node ids: ' + kind, () => {
  assert.equal(session.nodeId(kind, id), expected);
  assert.deepEqual(session.parseNodeId(expected), { kind, id });
});

test('model reference node ids distinguish agent and user references with the same id', () => {
  const model = session.model({ refs: [{ id: 'r1', target: 'q2:a' }] }, { refs: [{ id: 'r1', target: 'idea' }] });
  assert.deepEqual(model.refs.map(ref => [ref.nodeId, ref.target, ref.parsedTarget]),
    [['ref:agent:r1', 'q2:a', { questionId: 'q2', optionId: 'a' }]]);
  assert.deepEqual(model.userRefs.map(ref => [ref.nodeId, ref.target, ref.parsedTarget]),
    [['ref:user:r1', 'idea', { questionId: 'idea', optionId: '' }]]);
});

test('model valid dependencies remove self, unknown ids and repeats while preserving order', () => {
  const model = session.model({ questions: [
    { id: 'q1', dependsOn: ['q1', 'unknown', 'q3', 'q2', 'q3', 'q2', 'toString'] }, { id: 'q2' }, { id: 'q3' }
  ] });
  assert.deepEqual(model.questions.map(q => [q.id, q.validDependencies]), [['q1', ['q3', 'q2']], ['q2', []], ['q3', []]]);
});

test('model groups research by parsed question target and keeps board notes in file order', () => {
  const model = session.model({ questions: [{ id: 'q2' }, { id: 'q1' }], research: [
    { id: 's1', target: 'q1:b' }, { id: 's2', target: '' }, { id: 's3', target: 'q1' },
    { id: 's4', target: 'unknown:a' }, { id: 's5', target: 'idea' }, { id: 's6', target: 'q2' }
  ] });
  assert.deepEqual(model.questions.map(q => [q.id, q.research.map(note => note.id)]), [['q2', ['s6']], ['q1', ['s1', 's3']]]);
  assert.deepEqual(model.boardResearch.map(note => [note.id, note.target, note.parsedTarget]), [
    ['s2', '', { questionId: '', optionId: '' }], ['s4', 'unknown:a', { questionId: 'unknown', optionId: 'a' }],
    ['s5', 'idea', { questionId: 'idea', optionId: '' }]
  ]);
  assert.deepEqual(model.questionsById.q1.research.map(note => [note.target, note.parsedTarget]), [
    ['q1:b', { questionId: 'q1', optionId: 'b' }], ['q1', { questionId: 'q1', optionId: '' }]
  ]);
});

test('model option pictures use the first usable picture, agent before user, and pin duplicates to the question', () => {
  const model = session.model({ questions: [{ id: 'q1', status: 'asking', options: [{ id: 'a' }, { id: 'b', sketch: 'sketch/b.html' }] }], refs: [
    { id: 'unsafe', src: 'javascript:bad.svg', target: 'q1:a' },
    { id: 'link', src: 'https://example.com/page', target: 'q1:a' },
    { id: 'first', src: ' refs/first.svg?rev=2#image ', target: 'q1:a' },
    { id: 'second', src: 'refs/second.png', target: 'q1:a' },
    { id: 'invalid-option', src: 'refs/other.png', target: 'q1:z' },
    { id: 'extra-part', src: 'refs/other.png', target: 'q1:b:extra' }
  ] }, { refs: [
    { id: 'user-duplicate', kind: 'image', src: 'refs/user.png', target: 'q1:a' },
    { id: 'user-picture', kind: 'image', src: 'refs/without-extension', target: 'q1:b' },
    { id: 'idea', kind: 'image', src: 'refs/idea.png', target: 'idea' }
  ] });
  assert.deepEqual(Object.entries(model.questionsById.q1.optionPictures).map(([option, ref]) => [option, ref.nodeId, ref.src]),
    [['a', 'ref:agent:first', 'refs/first.svg?rev=2#image'], ['b', 'ref:user:user-picture', 'refs/without-extension']]);
  assert.deepEqual(model.optionPictures.map(ref => ref.nodeId), ['ref:agent:first', 'ref:user:user-picture']);
  assert.deepEqual(model.boardRefs.map(ref => [ref.nodeId, ref.anchorId, ref.target, ref.parsedTarget]), [
    ['ref:agent:link', 'q1', 'q1:a', { questionId: 'q1', optionId: 'a' }],
    ['ref:agent:second', 'q1', 'q1:a', { questionId: 'q1', optionId: 'a' }],
    ['ref:agent:invalid-option', '', 'q1:z', { questionId: 'q1', optionId: 'z' }],
    ['ref:agent:extra-part', '', 'q1:b:extra', { questionId: 'q1', optionId: 'b' }],
    ['ref:user:user-duplicate', 'q1', 'q1:a', { questionId: 'q1', optionId: 'a' }],
    ['ref:user:idea', '@idea', 'idea', { questionId: 'idea', optionId: '' }]
  ]);
  assert.equal(model.refs[2].src, ' refs/first.svg?rev=2#image ');
});

test('model option pictures exclude waiting questions and include settled and researching questions', () => {
  const model = session.model({ questions: [
    { id: 'q1', status: 'waiting', options: [{ id: 'a' }] },
    { id: 'q2', status: 'settled', options: [{ id: 'a' }] },
    { id: 'q3', status: 'researching', options: [{ id: 'a' }] }
  ], refs: [
    { id: 'r1', src: 'refs/image.svg', target: 'q1:a' },
    { id: 'r2', src: 'refs/image.svg', target: 'q2:a' },
    { id: 'r3', src: 'refs/image.svg', target: 'q3:a' }
  ] });
  assert.deepEqual(model.questions.map(q => [q.id, Object.entries(q.optionPictures).map(([id, ref]) => [id, ref.nodeId])]),
    [['q1', []], ['q2', [['a', 'ref:agent:r2']]], ['q3', [['a', 'ref:agent:r3']]]]);
  assert.deepEqual(model.boardRefs.map(ref => [ref.nodeId, ref.anchorId]), [['ref:agent:r1', 'q1']]);
});

test('model option lookup supports ids that name object prototype properties', () => {
  const model = session.model({ questions: [{ id: 'q1', status: 'asking', options: [{ id: '__proto__' }, { id: 'toString' }] }], refs: [
    { id: 'r1', src: 'refs/image.svg', target: 'q1:__proto__' }, { id: 'r2', src: 'refs/image.svg', target: 'q1:toString' }
  ] });
  assert.deepEqual(Object.entries(model.questionsById.q1.optionPictures).map(([id, ref]) => [id, ref.nodeId]),
    [['__proto__', 'ref:agent:r1'], ['toString', 'ref:agent:r2']]);
});

test('session exports match the documented interface without batchNumber', () => {
  assert.deepEqual(Object.keys(session), ['model', 'parseTarget', 'hasAnswer', 'ANSWER_TEXT_MAX', 'questionNumber', 'nodeId', 'parseNodeId',
    'object', 'string', 'array', 'singleWebUrl', 'safeSource', 'isPicture']);
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

test('source helper preserves relative and HTTP(S) destinations for server and disk bases', () => {
  const sources = [' refs/image.svg ', '#image', 'https://example.com/image.svg', 'http://[invalid', '//example.com/image.svg',
    'javascript:bad.svg', 'file:///image.svg', 'refs\\image.svg', 'refs/\u0000image.svg', ''];
  for (const baseUrl of ['http://127.0.0.1:1234/session.js', 'file:///tmp/board/session.js']) {
    assert.deepEqual(sources.map(src => session.safeSource(src, baseUrl)),
      ['refs/image.svg', '#image', 'https://example.com/image.svg', '', '', '', '', '', '', '']);
  }
});

test('picture helper retains image kind and extension rules', () => {
  assert.deepEqual([
    { kind: 'image', src: 'refs/no-extension' }, { kind: 'link', src: 'refs/PHOTO.JPEG?rev=1#picture' },
    { kind: '', src: 'refs/image.svg' }, { kind: '', src: 'refs/image.webp' },
    { kind: 'link', src: 'https://example.com/page' }, { kind: '', src: 'refs/image.png.html' }
  ].map(session.isPicture), [true, true, true, true, false, false]);
});

test('node parsing preserves suffixes and unknown node kinds are rejected', () => {
  assert.equal(session.nodeId('report', 's1:detail'), 'report:s1:detail');
  assert.deepEqual(session.parseNodeId('report:s1:detail'), { kind: 'report', id: 's1:detail' });
  assert.throws(() => session.nodeId('unknown', 's1'), { message: 'Unknown board node kind: unknown' });
});
