import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBlock } from './load-block.mjs';

const changes = loadBlock('grill-changes', 'GrillChanges');
const session = loadBlock('grill-session', 'GrillSession');
const question = (status, extra = {}) => ({ id: 'q1', status, options: [{ id: 'a', label: 'List' }], ...extra });
const note = (status, extra = {}) => ({ id: 's1', status, target: 'q1', topic: 'Storage', ...extra });
const sketch = (rev = 1, extra = {}) => ({ id: 'k1', src: 'sketch/home.html', rev, ...extra });

const model = (raw = {}, user = {}) => session.model(raw, user);
function expect(actual, expected = {}) {
  assert.deepEqual(actual, {
    highlights: {}, collapsedQuestions: [], newQuestions: [], changedResearch: [], viewTarget: null,
    ...expected,
  });
}
const idle = { idle: true };

test('waiting to asking highlights the question and focuses all asking questions in file order', () => {
  expect(changes.between(model({ questions: [question('waiting'), question('asking', { id: 'q2' })] }),
    model({ questions: [question('asking'), question('asking', { id: 'q2' })] }), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1', 'q2'] },
  });
});

test('settling an expanded asking question requests collapse and no view move', () => {
  expect(changes.between(model({ questions: [question('asking')] }), model({ questions: [question('settled')] }), idle), {
    highlights: { q1: ['question-status'] }, collapsedQuestions: ['q1'],
  });
});

test('reopening a settled question highlights and focuses without collapsing', () => {
  expect(changes.between(model({ questions: [question('settled')] }), model({ questions: [question('asking', { reopened: true })] }), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('questions that start to be asked are listed as new, in file order, and only once', () => {
  const previous = model({ questions: [question('waiting'), question('settled', { id: 'q2' }), question('asking', { id: 'q3' })] });
  const current = model({ questions: [question('asking'), question('asking', { id: 'q2', reopened: true }), question('asking', { id: 'q3' }),
    question('asking', { id: 'q4' }), question('waiting', { id: 'q5' })] });
  assert.deepEqual(changes.between(previous, current, { idle: false }).newQuestions, ['q1', 'q2', 'q4']);
  assert.deepEqual(changes.between(current, current, { idle: false }).newQuestions, []);
  assert.deepEqual(changes.between(null, current, { idle: false }).newQuestions, []);
});

test('reopened metadata alone does not cause a change', () => {
  expect(changes.between(model({ questions: [question('asking')] }), model({ questions: [question('asking', { reopened: true })] }), idle));
});

test('todo to running highlights the research chip, rather than its question', () => {
  expect(changes.between(model({ questions: [question('asking')], research: [note('todo')] }),
    model({ questions: [question('asking')], research: [note('running')] }), idle), {
    changedResearch: ['s1'],
  });
});

test('standalone research highlights its node on a status change', () => {
  expect(changes.between(model({ research: [note('todo', { target: 'idea' })] }),
    model({ research: [note('running', { target: 'idea' })] }), idle), {
    highlights: { 'research:s1': ['research-status'] }, changedResearch: ['s1'],
  });
});

test('running to done with a report highlights and focuses the report beside its question', () => {
  expect(changes.between(model({ questions: [question('asking')], research: [note('running')] }),
    model({ questions: [question('asking')], research: [note('done', { report: 'research/s1.md' })] }), idle), {
    highlights: { 'report:s1': ['report-added'] }, changedResearch: ['s1'],
    viewTarget: { kind: 'report', nodeIds: ['q1', 'report:s1'] },
  });
});

test('a report with no known question focuses beside the idea', () => {
  expect(changes.between(model(), model({ research: [note('done', { target: 'unknown', report: 'research/s1.md' })] }), idle), {
    highlights: { 'research:s1': ['research-status'], 'report:s1': ['report-added'] },
    changedResearch: ['s1'], viewTarget: { kind: 'report', nodeIds: ['@idea', 'report:s1'] },
  });
});

test('a sketch appearing highlights and focuses beside the idea', () => {
  expect(changes.between(model(), model({ sketches: [sketch()] }), idle), {
    highlights: { 'sketch:k1': ['sketch-added'] }, viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k1'] },
  });
});

test('a higher sketch revision highlights and takes the view when nothing else is new', () => {
  expect(changes.between(model({ sketches: [sketch()] }), model({ sketches: [sketch(2)] }), idle), {
    highlights: { 'sketch:k1': ['sketch-revised'] }, viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k1'] },
  });
  expect(changes.between(model({ sketches: [sketch()] }), model({ sketches: [sketch(2)] }), { idle: false }), {
    highlights: { 'sketch:k1': ['sketch-revised'] },
  });
});

test('new asking questions win over a revised sketch', () => {
  expect(changes.between(model({ questions: [question('waiting')], sketches: [sketch()] }),
    model({ questions: [question('asking')], sketches: [sketch(2)] }), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'], 'sketch:k1': ['sketch-revised'] }, viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('same or lower revisions and changed sketch sources do not highlight', () => {
  expect(changes.between(model({ sketches: [sketch(2)] }), model({ sketches: [sketch(2, { src: 'sketch/new.html' })] }), idle));
  expect(changes.between(model({ sketches: [sketch(2)] }), model({ sketches: [sketch(1)] }), idle));
});

test('new sketches win over new reports and asking questions, preserving sketch order', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')],
    sketches: [sketch(1, { id: 'k2' }), sketch()], research: [note('done', { report: 'research/s1.md' })] }), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'], 'sketch:k2': ['sketch-added'], 'sketch:k1': ['sketch-added'], 'report:s1': ['report-added'] },
    changedResearch: ['s1'],
    viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k2', 'sketch:k1'] },
  });
});

test('the first new report wins over asking questions and later reports', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')],
    research: [note('done', { id: 's2', report: 'research/s2.md' }), note('done', { report: 'research/s1.md' })] }), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'], 'report:s2': ['report-added'], 'report:s1': ['report-added'] },
    changedResearch: ['s2', 's1'],
    viewTarget: { kind: 'report', nodeIds: ['q1', 'report:s2'] },
  });
});

test('a new reference highlights its node, whether the user or the agent added it', () => {
  expect(changes.between(model(), model({ refs: [{ id: 'r1', src: 'https://example.com/a' }] },
    { refs: [{ id: 'u1', kind: 'link', src: 'https://example.com/b' }] }), idle), {
    highlights: { 'ref:agent:r1': ['reference-added'], 'ref:user:u1': ['reference-added'] },
  });
});

test('a reference that was already on the board does not highlight again', () => {
  const raw = { refs: [{ id: 'r1', src: 'https://example.com/a' }] }, user = { refs: [{ id: 'u1', src: 'https://example.com/b' }] };
  expect(changes.between(model(raw, user), model(raw, user), idle));
});

test('a new option picture highlights the question instead of a reference node', () => {
  expect(changes.between(model({ questions: [question('asking')] }), model({ questions: [question('asking')] },
    { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] }), idle), {
    highlights: { q1: ['reference-added'] },
  });
});

test('waiting option pictures remain standalone and highlight their reference node', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('waiting')] },
    { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] }), idle), {
    highlights: { 'ref:user:u1': ['reference-added'] },
  });
});

test('a reference that becomes an option picture when its question is asked is not new', () => {
  const user = { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] };
  expect(changes.between(model({ questions: [question('waiting')] }, user), model({ questions: [question('asking')] }, user), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('first render collapses settled questions, highlights nothing and does not move the view', () => {
  expect(changes.between(null, model({ questions: [question('settled'), question('asking', { id: 'q2' })], sketches: [sketch()],
    refs: [{ id: 'r1', src: 'https://example.com/a' }],
    research: [note('todo'), note('done', { id: 's2', target: 'idea', report: 'research/s2.md' })] }, { refs: [{ id: 'u1', src: 'https://example.com/b' }] }), idle), {
    collapsedQuestions: ['q1'],
  });
});

test('two identical models cause no highlights, collapses or view move', () => {
  const raw = { questions: [question('settled')], sketches: [sketch()], research: [note('done', { report: 'research/s1.md' })] };
  expect(changes.between(model(raw), model(raw), idle), {});
});

test('idle gates only the view move for the same asking transition', () => {
  const previous = model({ questions: [question('waiting')] }), current = model({ questions: [question('asking')] });
  expect(changes.between(previous, current, { idle: false }), { newQuestions: ['q1'], highlights: { q1: ['question-status'] } });
  expect(changes.between(previous, current, idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('recent interaction also prevents sketch and report focus while keeping highlights', () => {
  expect(changes.between(model(), model({ sketches: [sketch()], research: [note('done', { target: 'idea', report: 'research/s1.md' })] }), { idle: false }), {
    highlights: { 'research:s1': ['research-status'], 'sketch:k1': ['sketch-added'], 'report:s1': ['report-added'] },
    changedResearch: ['s1'],
  });
});

test('unusable sketches and reports do not count as previously present', () => {
  expect(changes.between(model({ sketches: [sketch(1, { src: 'javascript:bad' })], research: [note('done', { target: 'q1', report: 'javascript:bad' })] }),
    model({ questions: [question('waiting')], sketches: [sketch()], research: [note('done', { report: 'research/s1.md' })] }), idle), {
    highlights: { q1: ['question-status'], 'sketch:k1': ['sketch-added'], 'report:s1': ['report-added'] },
    changedResearch: [], viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k1'] },
  });
});

test('an existing report with a changed source is not new', () => {
  expect(changes.between(model({ research: [note('done', { report: 'research/old.md' })] }),
    model({ research: [note('done', { report: 'research/new.md' })] }), idle), {
  });
});

test('canonical ids are read from model fields and inputs stay unchanged', () => {
  const previous = model(), current = model({ sketches: [sketch()] });
  current.ideaNodeId = 'canonical-idea'; current.sketches[0].nodeId = 'canonical-sketch';
  const context = { idle: true }, before = JSON.stringify([previous, current, context]);
  expect(changes.between(previous, current, context), {
    highlights: { 'canonical-sketch': ['sketch-added'] }, viewTarget: { kind: 'sketches', nodeIds: ['canonical-idea', 'canonical-sketch'] },
  });
  assert.equal(JSON.stringify([previous, current, context]), before);
  assert.deepEqual(Object.keys(changes), ['between']);
});

test('omitting context does not infer idleness', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')] })), {
    newQuestions: ['q1'], highlights: { q1: ['question-status'] },
  });
  expect(changes.between(null, model()));
});

test('changes retain every highlight reason when an option picture and a status arrive together', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')] },
    { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] }), idle), {
    newQuestions: ['q1'], highlights: { q1: ['question-status', 'reference-added'] },
    viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('research and report destinations also use canonical model fields', () => {
  const current = model({ research: [note('done', { target: 'idea', report: 'research/s1.md' })] });
  current.ideaNodeId = 'canonical-idea';
  current.research[0].nodeId = 'canonical-research'; current.research[0].reportNodeId = 'canonical-report';
  expect(changes.between(model(), current, idle), {
    highlights: { 'canonical-research': ['research-status'], 'canonical-report': ['report-added'] },
    changedResearch: ['s1'],
    viewTarget: { kind: 'report', nodeIds: ['canonical-idea', 'canonical-report'] },
  });
});
