import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBlock } from './load-block.mjs';

const changes = loadBlock('grill-changes', 'GrillChanges');
const session = loadBlock('grill-session', 'GrillSession');
const question = (status, extra = {}) => ({ id: 'q1', status, options: [{ id: 'a', label: 'List' }], ...extra });
const note = (status, extra = {}) => ({ id: 's1', status, target: 'q1', topic: 'Storage', ...extra });
const sketch = (rev = 1, extra = {}) => ({ id: 'k1', src: 'sketch/home.html', rev, ...extra });

// Match render's projection: the session lane does not yet expose these node ids or usable groups.
function model(raw = {}, user = {}) {
  const value = session.model(raw, user);
  value.ideaNodeId = session.nodeId('idea');
  for (const item of value.sketches) item.nodeId = session.nodeId('sketch', item.id);
  for (const item of value.research) {
    item.nodeId = session.nodeId('research', item.id);
    item.reportNodeId = session.nodeId('report', item.id);
  }
  value.boardSketches = value.sketches.filter(item => session.safeSource(item.src));
  value.boardReports = value.researchByStatus.done.filter(item => session.safeSource(item.report));
  return value;
}
function expect(actual, expected = {}) {
  assert.deepEqual(actual, {
    highlights: {}, collapsedQuestions: [], research: {}, consumedReferenceIds: [], viewTarget: null,
    ...expected,
  });
}
const idle = { idle: true };

test('waiting to asking highlights the question and focuses all asking questions in file order', () => {
  expect(changes.between(model({ questions: [question('waiting'), question('asking', { id: 'q2' })] }),
    model({ questions: [question('asking'), question('asking', { id: 'q2' })] }), idle), {
    highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1', 'q2'] },
  });
});

test('settling an expanded asking question requests collapse and no view move', () => {
  expect(changes.between(model({ questions: [question('asking')] }), model({ questions: [question('settled')] }), idle), {
    highlights: { q1: ['question-status'] }, collapsedQuestions: ['q1'],
  });
});

test('reopening a settled question highlights and focuses without collapsing', () => {
  expect(changes.between(model({ questions: [question('settled')] }), model({ questions: [question('asking', { reopened: true })] }), idle), {
    highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('reopened metadata alone does not cause a change', () => {
  expect(changes.between(model({ questions: [question('asking')] }), model({ questions: [question('asking', { reopened: true })] }), idle));
});

test('todo to running highlights the research chip, rather than its question', () => {
  expect(changes.between(model({ questions: [question('asking')], research: [note('todo')] }),
    model({ questions: [question('asking')], research: [note('running')] }), idle), {
    research: { s1: { previousStatus: 'todo', changed: true } },
  });
});

test('standalone research highlights its node on a status change', () => {
  expect(changes.between(model({ research: [note('todo', { target: 'idea' })] }),
    model({ research: [note('running', { target: 'idea' })] }), idle), {
    highlights: { 'research:s1': ['research-status'] }, research: { s1: { previousStatus: 'todo', changed: true } },
  });
});

test('running to done with a report highlights and focuses the report beside its question', () => {
  expect(changes.between(model({ questions: [question('asking')], research: [note('running')] }),
    model({ questions: [question('asking')], research: [note('done', { report: 'research/s1.md' })] }), idle), {
    highlights: { 'report:s1': ['report-added'] }, research: { s1: { previousStatus: 'running', changed: true } },
    viewTarget: { kind: 'report', nodeIds: ['q1', 'report:s1'] },
  });
});

test('a report with no known question focuses beside the idea', () => {
  expect(changes.between(model(), model({ research: [note('done', { target: 'unknown', report: 'research/s1.md' })] }), idle), {
    highlights: { 'research:s1': ['research-status'], 'report:s1': ['report-added'] },
    research: { s1: { previousStatus: null, changed: true } }, viewTarget: { kind: 'report', nodeIds: ['@idea', 'report:s1'] },
  });
});

test('a sketch appearing highlights and focuses beside the idea', () => {
  expect(changes.between(model(), model({ sketches: [sketch()] }), idle), {
    highlights: { 'sketch:k1': ['sketch-added'] }, viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k1'] },
  });
});

test('a higher sketch revision highlights without moving the view', () => {
  expect(changes.between(model({ sketches: [sketch()] }), model({ sketches: [sketch(2)] }), idle), {
    highlights: { 'sketch:k1': ['sketch-revised'] },
  });
});

test('same or lower revisions and changed sketch sources do not highlight', () => {
  expect(changes.between(model({ sketches: [sketch(2)] }), model({ sketches: [sketch(2, { src: 'sketch/new.html' })] }), idle));
  expect(changes.between(model({ sketches: [sketch(2)] }), model({ sketches: [sketch(1)] }), idle));
});

test('new sketches win over new reports and asking questions, preserving sketch order', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')],
    sketches: [sketch(1, { id: 'k2' }), sketch()], research: [note('done', { report: 'research/s1.md' })] }), idle), {
    highlights: { q1: ['question-status'], 'sketch:k2': ['sketch-added'], 'sketch:k1': ['sketch-added'], 'report:s1': ['report-added'] },
    research: { s1: { previousStatus: null, changed: true } },
    viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k2', 'sketch:k1'] },
  });
});

test('the first new report wins over asking questions and later reports', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')],
    research: [note('done', { id: 's2', report: 'research/s2.md' }), note('done', { report: 'research/s1.md' })] }), idle), {
    highlights: { q1: ['question-status'], 'report:s2': ['report-added'], 'report:s1': ['report-added'] },
    research: { s2: { previousStatus: null, changed: true }, s1: { previousStatus: null, changed: true } },
    viewTarget: { kind: 'report', nodeIds: ['q1', 'report:s2'] },
  });
});

test('a board-added user link highlights and consumes only its pending id', () => {
  const current = model({}, { refs: [{ id: 'u1', kind: 'link', src: 'https://example.com' }] });
  expect(changes.between(model(), current, { ...idle, addedReferenceIds: new Set(['ref:user:u1', 'ref:user:u2']) }), {
    highlights: { 'ref:user:u1': ['user-reference'] }, consumedReferenceIds: ['ref:user:u1'],
  });
});

test('agent references and user references without a board-added id do not highlight', () => {
  expect(changes.between(model(), model({ refs: [{ id: 'r1', src: 'https://example.com' }] },
    { refs: [{ id: 'u1', src: 'https://example.com' }] }), idle));
});

test('a board-added option picture highlights the question instead of a reference node', () => {
  expect(changes.between(model({ questions: [question('asking')] }), model({ questions: [question('asking')] },
    { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] }), { ...idle, addedReferenceIds: ['ref:user:u1'] }), {
    highlights: { q1: ['user-reference'] }, consumedReferenceIds: ['ref:user:u1'],
  });
});

test('waiting option pictures remain standalone and highlight their reference node', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('waiting')] },
    { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] }), { ...idle, addedReferenceIds: ['ref:user:u1'] }), {
    highlights: { 'ref:user:u1': ['user-reference'] }, consumedReferenceIds: ['ref:user:u1'],
  });
});

test('first render collapses settled questions and highlights research, but not questions, sketches or reports', () => {
  expect(changes.between(null, model({ questions: [question('settled')], sketches: [sketch()],
    research: [note('todo'), note('done', { id: 's2', target: 'idea', report: 'research/s2.md' })] }), idle), {
    highlights: { 'research:s2': ['research-status'] }, collapsedQuestions: ['q1'],
    research: { s1: { previousStatus: null, changed: true }, s2: { previousStatus: null, changed: true } },
  });
});

test('first render still honors board-added reference ids', () => {
  expect(changes.between(null, model({}, { refs: [{ id: 'u1', src: 'https://example.com' }] }), { ...idle, addedReferenceIds: ['ref:user:u1'] }), {
    highlights: { 'ref:user:u1': ['user-reference'] }, consumedReferenceIds: ['ref:user:u1'],
  });
});

test('two identical models cause no highlights, collapses or view move', () => {
  const raw = { questions: [question('settled')], sketches: [sketch()], research: [note('done', { report: 'research/s1.md' })] };
  expect(changes.between(model(raw), model(raw), idle), { research: { s1: { previousStatus: 'done', changed: false } } });
});

test('idle gates only the view move for the same asking transition', () => {
  const previous = model({ questions: [question('waiting')] }), current = model({ questions: [question('asking')] });
  expect(changes.between(previous, current, { idle: false }), { highlights: { q1: ['question-status'] } });
  expect(changes.between(previous, current, idle), {
    highlights: { q1: ['question-status'] }, viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('recent interaction also prevents sketch and report focus while keeping highlights', () => {
  expect(changes.between(model(), model({ sketches: [sketch()], research: [note('done', { target: 'idea', report: 'research/s1.md' })] }), { idle: false }), {
    highlights: { 'research:s1': ['research-status'], 'sketch:k1': ['sketch-added'], 'report:s1': ['report-added'] },
    research: { s1: { previousStatus: null, changed: true } },
  });
});

test('unusable sketches and reports do not count as previously present', () => {
  expect(changes.between(model({ sketches: [sketch(1, { src: 'javascript:bad' })], research: [note('done', { target: 'q1', report: 'javascript:bad' })] }),
    model({ questions: [question('waiting')], sketches: [sketch()], research: [note('done', { report: 'research/s1.md' })] }), idle), {
    highlights: { q1: ['question-status'], 'sketch:k1': ['sketch-added'], 'report:s1': ['report-added'] },
    research: { s1: { previousStatus: 'done', changed: false } }, viewTarget: { kind: 'sketches', nodeIds: ['@idea', 'sketch:k1'] },
  });
});

test('an existing report with a changed source is not new', () => {
  expect(changes.between(model({ research: [note('done', { report: 'research/old.md' })] }),
    model({ research: [note('done', { report: 'research/new.md' })] }), idle), {
    research: { s1: { previousStatus: 'done', changed: false } },
  });
});

test('canonical ids are read from model fields and inputs stay unchanged', () => {
  const previous = model(), current = model({ sketches: [sketch()] });
  current.ideaNodeId = 'canonical-idea'; current.sketches[0].nodeId = 'canonical-sketch';
  const context = { idle: true, addedReferenceIds: [] }, before = JSON.stringify([previous, current, context]);
  expect(changes.between(previous, current, context), {
    highlights: { 'canonical-sketch': ['sketch-added'] }, viewTarget: { kind: 'sketches', nodeIds: ['canonical-idea', 'canonical-sketch'] },
  });
  assert.equal(JSON.stringify([previous, current, context]), before);
  assert.deepEqual(Object.keys(changes), ['between']);
});

test('omitting context does not infer idleness or reference additions', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')] })), {
    highlights: { q1: ['question-status'] },
  });
  expect(changes.between(null, model()));
});

test('changes retain every highlight reason when an option picture and a status arrive together', () => {
  expect(changes.between(model({ questions: [question('waiting')] }), model({ questions: [question('asking')] },
    { refs: [{ id: 'u1', kind: 'image', src: 'ref.png', target: 'q1:a' }] }), { ...idle, addedReferenceIds: ['ref:user:u1'] }), {
    highlights: { q1: ['question-status', 'user-reference'] }, consumedReferenceIds: ['ref:user:u1'],
    viewTarget: { kind: 'questions', nodeIds: ['q1'] },
  });
});

test('research and report destinations also use canonical model fields', () => {
  const current = model({ research: [note('done', { target: 'idea', report: 'research/s1.md' })] });
  current.ideaNodeId = 'canonical-idea';
  current.research[0].nodeId = 'canonical-research'; current.research[0].reportNodeId = 'canonical-report';
  expect(changes.between(model(), current, idle), {
    highlights: { 'canonical-research': ['research-status'], 'canonical-report': ['report-added'] },
    research: { s1: { previousStatus: null, changed: true } },
    viewTarget: { kind: 'report', nodeIds: ['canonical-idea', 'canonical-report'] },
  });
});
