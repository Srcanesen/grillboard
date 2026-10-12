import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBlock } from './load-block.mjs';

const layout = loadBlock('grill-layout', 'GrillLayout');
const constants = { ideaWidth: 380, gapX: 28, gapY: 64, lrGapX: 96, lrGapY: 28 };
const idea = { id: '@idea', kind: 'idea', width: 380, height: 80 };
const question = (id, validDependencies = [], height = 100) => ({ id, kind: 'question', width: 300, height, validDependencies });
const input = (nodes, options = {}) => ({ nodes: [idea, ...nodes], flow: 'td', constants, ...options });
const positions = result => ({ ...result.positions });

test('idea alone is centred at the origin', () => {
  assert.deepEqual(positions(layout.layout(input([]))), { '@idea': { x: -190, y: 0 } });
});

test('one question sits under the idea', () => {
  const result = layout.layout(input([question('q1')]));
  assert.deepEqual(positions(result), { '@idea': { x: -190, y: 0 }, q1: { x: -150, y: 144 } });
  assert.deepEqual({ ...result.parents }, { '@idea': null, q1: '@idea' });
});

test('two siblings keep the card gap and centre their parent', () => {
  assert.deepEqual(positions(layout.layout(input([question('q1'), question('q2')]))), {
    '@idea': { x: -190, y: 0 }, q1: { x: -314, y: 144 }, q2: { x: 14, y: 144 },
  });
});

test('a child follows its first valid dependency and keeps secondary links', () => {
  const result = layout.layout(input([question('q1'), question('q2'), question('q3', ['missing', 'q3', 'q2', 'q1'])]));
  assert.deepEqual(positions(result), {
    '@idea': { x: -190, y: 0 }, q1: { x: -314, y: 144 }, q2: { x: 14, y: 144 }, q3: { x: 14, y: 308 },
  });
  assert.equal(result.parents.q3, 'q2');
  assert.deepEqual(result.secondary.q3, ['q1']);
});

test('a cycle gets one deterministic root and every question has a literal position', () => {
  const result = layout.layout(input([question('q1', ['q2']), question('q2', ['q1'])]));
  assert.deepEqual({ ...result.parents }, { '@idea': null, q1: '@idea', q2: 'q1' });
  assert.deepEqual(positions(result), {
    '@idea': { x: -190, y: 0 }, q1: { x: -150, y: 144 }, q2: { x: -150, y: 308 },
  });
});

const attachments = [
  { id: 'report:s1', kind: 'report', width: 300, height: 40, parsedTarget: { questionId: 'q1' } },
  { id: 'ref:r1', kind: 'reference', width: 200, height: 60, anchorId: 'q1' },
  { id: 'ref:r2', kind: 'reference', width: 180, height: 70, anchorId: 'q1' },
];

test('top-down reports stack below the card and references beside it', () => {
  const result = layout.layout(input([question('q1'), ...attachments, question('q2', ['q1'])]));
  assert.deepEqual(positions(result), {
    '@idea': { x: -190, y: 0 }, q1: { x: -150, y: 144 }, q2: { x: -150, y: 356 },
    'report:s1': { x: -150, y: 252 }, 'ref:r1': { x: 174, y: 144 }, 'ref:r2': { x: 174, y: 216 },
  });
  assert.equal(result.clusters[1].width, 524);
  assert.equal(result.clusters[1].height, 148);
});

test('left-to-right references follow the report stack below the card', () => {
  const result = layout.layout(input([question('q1'), ...attachments, question('q2', ['q1'])], { flow: 'lr' }));
  assert.deepEqual(positions(result), {
    '@idea': { x: 0, y: -40 }, q1: { x: 476, y: -50 }, q2: { x: 872, y: -50 },
    'report:s1': { x: 476, y: 58 }, 'ref:r1': { x: 476, y: 122 }, 'ref:r2': { x: 476, y: 194 },
  });
  assert.equal(result.clusters[1].width, 300);
  assert.equal(result.clusters[1].height, 314);
});

test('a taller card pushes its report and the next level down', () => {
  const result = layout.layout(input([question('q1', [], 180), ...attachments, question('q2', ['q1'])]));
  assert.deepEqual(result.positions['report:s1'], { x: -150, y: 332 });
  assert.deepEqual(result.positions.q2, { x: -150, y: 436 });
  assert.equal(result.clusters[1].height, 228);
});

test('a taller left-to-right card pushes the references below its reports', () => {
  const result = layout.layout(input([question('q1', [], 180), ...attachments], { flow: 'lr' }));
  assert.deepEqual(result.positions.q1, { x: 476, y: -90 });
  assert.deepEqual(result.positions['report:s1'], { x: 476, y: 98 });
  assert.deepEqual(result.positions['ref:r1'], { x: 476, y: 162 });
  assert.equal(result.clusters[1].height, 394);
});

test('manual offsets move a card, attachments and its subtree, preserving base positions', () => {
  const result = layout.layout(input([question('q1'), ...attachments, question('q2', ['q1'])], {
    manualOffsets: { q1: { dx: 120, dy: 60 }, q2: { dx: 10, dy: -5 } },
  }));
  assert.deepEqual(positions(result), {
    '@idea': { x: -190, y: 0 }, q1: { x: -30, y: 204 }, q2: { x: -20, y: 411 },
    'report:s1': { x: -30, y: 312 }, 'ref:r1': { x: 294, y: 204 }, 'ref:r2': { x: 294, y: 276 },
  });
  assert.deepEqual(result.basePositions.q1, { x: -150, y: 144 });
});

test('live cluster geometry places attachments and chooses the lowest attached report output', () => {
  const node = { id: 'q1', x: 10, y: 20, width: 300, height: 180 };
  const reports = [attachments[0], { id: 'report:s2', width: 300, height: 30 }];
  const refs = attachments.slice(1);
  const result = layout.cluster({ node, reports, refs, flow: 'lr' });
  assert.deepEqual(positions(result), {
    q1: { x: 10, y: 20 }, 'report:s1': { x: 10, y: 208 }, 'report:s2': { x: 10, y: 256 },
    'ref:r1': { x: 10, y: 310 }, 'ref:r2': { x: 10, y: 382 },
  });
  assert.equal(result.outputId, 'report:s2');
  assert.equal(result.height, 432);
  const detached = layout.cluster({ node, reports: [{ ...reports[0], y: 500 }, reports[1]], refs, flow: 'td',
    manualOffsets: { 'report:s1': { dx: 1, dy: 0 } } });
  assert.equal(detached.outputId, 'report:s2');
  const live = layout.cluster({ node, reports: [{ ...reports[0], y: 500 }, reports[1]], refs, flow: 'td' });
  assert.equal(live.outputId, 'report:s1');
});

test('layout is repeatable, leaves inputs unchanged and returns deeply read-only results', () => {
  const data = input([question('q1'), ...attachments], { manualOffsets: { q1: { dx: 120, dy: 60 } } });
  const before = structuredClone(data);
  const first = layout.layout(data), second = layout.layout(data);
  assert.deepEqual(first.positions.q1, { x: -30, y: 204 });
  assert.deepEqual(first, second);
  assert.deepEqual(data, before);
  assert.equal(Object.isFrozen(data.nodes[1]), false);
  assert.throws(() => { first.positions.q1.x = 99; }, TypeError);
  assert.throws(() => { delete first.parents.q1; }, TypeError);
  assert.throws(() => { first.clusters[1].refs[0].height = 99; }, TypeError);
});

// Literal measured sizes and positions recorded in Chrome before extraction.
const demoNodes = [
  {"id":"@idea","width":380,"height":143,"kind":"idea","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q1","width":300,"height":164,"kind":"question","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q2","width":300,"height":129,"kind":"question","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q3","width":300,"height":191,"kind":"question","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q4","width":300,"height":229,"kind":"question","validDependencies":["q1"],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q5","width":300,"height":270,"kind":"question","validDependencies":["q2"],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q6","width":300,"height":149,"kind":"question","validDependencies":["q1","q2"],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q8","width":460,"height":559,"kind":"question","validDependencies":["q1","q3"],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"q7","width":300,"height":140,"kind":"question","validDependencies":["q4"],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"ref:agent:r4","width":200,"height":221,"kind":"reference","validDependencies":[],"anchorId":"q3","parsedTarget":{"questionId":"q3","optionId":""},"noteId":""},
  {"id":"ref:user:u1","width":200,"height":221,"kind":"reference","validDependencies":[],"anchorId":"q3","parsedTarget":{"questionId":"q3","optionId":""},"noteId":""},
  {"id":"ref:user:u2","width":200,"height":105,"kind":"reference","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"research:s4","width":240,"height":90,"kind":"research","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
  {"id":"report:s1","width":300,"height":56,"kind":"report","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"q2","optionId":""},"noteId":"s1"},
  {"id":"sketch:k1","width":402,"height":846,"kind":"sketch","validDependencies":[],"anchorId":"","parsedTarget":{"questionId":"","optionId":""},"noteId":""},
];

test('Chrome demo baseline: td', () => {
  const result = layout.layout({ nodes: demoNodes, constants, flow: 'td' });
  assert.deepEqual(positions(result), {
    "@idea": {"x": -190, "y": 0},
    "q1": {"x": -702, "y": 207},
    "q2": {"x": 74, "y": 207},
    "q3": {"x": 402, "y": 207},
    "q4": {"x": -1070, "y": 725},
    "q5": {"x": 74, "y": 725},
    "q6": {"x": -742, "y": 725},
    "q8": {"x": -414, "y": 725},
    "q7": {"x": -1070, "y": 1348},
    "ref:agent:r4": {"x": 726, "y": 207},
    "ref:user:u1": {"x": 726, "y": 440},
    "ref:user:u2": {"x": -1390, "y": 0},
    "research:s4": {"x": -1390, "y": 157},
    "report:s1": {"x": 74, "y": 344},
    "sketch:k1": {"x": -201, "y": -902},
  });
});

test('Chrome demo baseline: lr', () => {
  const result = layout.layout({ nodes: demoNodes, constants, flow: 'lr' });
  assert.deepEqual(positions(result), {
    "@idea": {"x": 0, "y": -71.5},
    "q1": {"x": 476, "y": -582.25},
    "q2": {"x": 476, "y": 177.25},
    "q3": {"x": 476, "y": 404.75},
    "q4": {"x": 872, "y": -914.25},
    "q5": {"x": 872, "y": 106.75},
    "q6": {"x": 872, "y": -657.25},
    "q8": {"x": 872, "y": -480.25},
    "q7": {"x": 1428, "y": -869.75},
    "ref:agent:r4": {"x": 476, "y": 619.75},
    "ref:user:u1": {"x": 476, "y": 852.75},
    "ref:user:u2": {"x": -778, "y": 0},
    "research:s4": {"x": -778, "y": 157},
    "report:s1": {"x": 476, "y": 314.25},
    "sketch:k1": {"x": -458, "y": -423},
  });
});
