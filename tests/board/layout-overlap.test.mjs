import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBlock } from './load-block.mjs';

const { layout } = loadBlock('grill-layout', 'GrillLayout');
const constants = { ideaWidth: 380, gapX: 28, gapY: 64, lrGapX: 96, lrGapY: 28, sketchRoundGap: 48 };
const seeds = [0x1248, 0x532a, 0x92f3, 0x164d1, 0x1df81, 0x28b53, 0x34967, 0x443cf];
const workingId = 'sketch:1';

// xorshift32, returning an integer in the inclusive range.
function seededInteger(seed) {
  let state = seed;
  return (min, max) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return min + (state >>> 0) % (max - min + 1);
  };
}

const question = (id, width, height, validDependencies = []) => ({ id, kind: 'question', width, height, validDependencies });
const idea = (height, width = 380) => ({ id: '@idea', kind: 'idea', width, height });
const sketch = (id, width, height) => ({ id, kind: 'sketch', width, height });
const flows = ['td', 'lr'];

function generateBoard(seed, count, depth, askingMode) {
  const integer = seededInteger(seed);
  const pick = values => values[integer(0, values.length - 1)];
  const questionIds = Array.from({ length: count }, (_, index) => `q${index + 1}`);
  const candidates = [...questionIds];
  const askingCount = Math.min(count, [0, 1, integer(2, 6)][askingMode]);
  const askingIds = Array.from({ length: askingCount }, () => candidates.splice(integer(0, candidates.length - 1), 1)[0]);
  const depths = [];
  const nodes = [idea(integer(90, 200), pick([320, 380, 520]))];

  // Depth starts at 1 for a root question. Build one full-depth branch, then branch from any eligible parent.
  for (const [index, id] of questionIds.entries()) {
    const eligible = questionIds.slice(0, index).filter((_, parent) => depths[parent] < depth);
    const parent = index < depth ? questionIds[index - 1] : pick([undefined, ...eligible]);
    depths.push(parent ? 1 + depths[questionIds.indexOf(parent)] : 1);
    const state = askingIds.includes(id) ? 'asking' : pick(['settled', 'waiting', 'researching']);
    // Approximate the measured card sizes, including picture options.
    const width = pick([240, 300, 300, 460, 600]);
    const height = {
      asking: () => integer(164, width === 460 ? 559 : 400),
      settled: () => integer(100, 240),
      waiting: () => integer(90, 164),
      researching: () => integer(129, 320),
    }[state]();
    nodes.push(question(id, width, height, parent ? [parent] : []));
    for (let row = integer(0, 2); row > 0; row--) {
      nodes.push({ id: `report:${id}-${row}`, kind: 'report', width: pick([width, 300, 520]),
        height: integer(48, 58), parsedTarget: { questionId: id } });
    }
  }

  for (const anchorId of ['', '@idea', ...questionIds]) {
    for (let ref = integer(0, 3); ref > 0; ref--) {
      const width = pick([160, 200, 200, 320, 460]);
      const height = integer(0, 1) ? integer(75, 130) : Math.round(160 * (width - 18) / 182) + integer(40, 90);
      nodes.push({ id: `ref:agent:${anchorId || 'board'}-${ref}`, kind: 'reference', width, height, anchorId });
    }
  }
  for (let note = integer(0, 3); note > 0; note--) {
    nodes.push({ id: `research:note-${note}`, kind: 'research', width: pick([200, 240, 360]), height: integer(80, 180) });
    if (integer(0, 1)) nodes.push({ id: `report:note-${note}`, kind: 'report', noteId: `note-${note}`,
      width: pick([200, 240, 420]), height: integer(105, 195) });
  }

  const sketchCount = integer(0, 3);
  for (let index = 1; index <= sketchCount; index++) {
    const id = `sketch:${index}`;
    if (id === workingId && integer(0, 1)) {
      nodes.push(sketch(id, 220, 42));
    } else {
      const [width, height] = pick([[342, 717], [402, 846], [582, 427], [742, 527]]);
      nodes.push(sketch(id, width, height));
    }
  }
  // Manual rectangles change what is drawn while reserving the original space.
  for (const node of nodes) {
    if (node.kind === 'sketch' || integer(0, 3) !== 0) continue;
    node.manualRect = { width: integer(200, 1080), height: integer(220, 950), dx: integer(-200, 0), dy: integer(-200, 0) };
  }
  const position = sketchCount && integer(0, 2) === 0 ? { x: integer(-400, 600), y: integer(-200, 500) } : undefined;
  return { nodes, constants, workingSketch: sketchCount ? { id: workingId, askingIds, position } : undefined };
}

function placedRectangles(input, label) {
  const { positions } = layout(input);
  return input.nodes.map(({ id, width, height, manualRect }) => {
    const point = positions[id];
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), `${label}: missing position for ${id}`);
    return { id, x: point.x, y: point.y, width: manualRect?.width ?? width, height: manualRect?.height ?? height };
  });
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertClear(pairs, label) {
  const overlaps = [];
  for (const [a, b] of pairs) {
    if (intersects(a, b)) overlaps.push(`${label}: ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`);
  }
  assert.equal(overlaps.length, 0, overlaps.join('\n'));
}

function* allPairs(rectangles) {
  for (const [index, a] of rectangles.entries()) {
    for (let next = index + 1; next < rectangles.length; next++) yield [a, rectangles[next]];
  }
}

test('a dragged working sketch clears a card at drop and after the card widens', () => {
  const nodes = [idea(143), question('q1', 300, 164), sketch(workingId, 402, 846)];
  const place = (x, askingIds = ['q1']) => placedRectangles({ nodes, flow: 'td', constants,
    workingSketch: { id: workingId, askingIds, position: { x, y: 207 } } }, 'dragged sketch');
  const dropped = place(50);
  assert.deepEqual(dropped.at(-1), { id: workingId, x: 198, y: 207, width: 402, height: 846 });
  assertClear(allPairs(dropped), 'drop');
  assert.equal(place(210).at(-1).x, 210);
  nodes[1].manualRect = { width: 500, height: 164, dx: -40 };
  const resized = place(210, []);
  assert.deepEqual(resized.at(-1), { id: workingId, x: 358, y: 207, width: 402, height: 846 });
  assertClear(allPairs(resized), 'resize');
});

for (const [index, firstSeed] of seeds.entries()) {
  for (let count = 1; count <= 40; count++) {
    const seed = firstSeed + count;
    const depth = Math.min(count, 1 + (index + count - 1) % 6);
    for (const flow of flows) {
      const label = `seed 0x${seed.toString(16)}, flow ${flow}`;
      test(`placed rectangles are clear (${label})`, () => {
        const board = generateBoard(seed, count, depth, (index + count) % 3);
        const rectangles = placedRectangles({ ...board, flow }, label);
        const working = rectangles.find(rect => rect.id === board.workingSketch?.id);
        const automatic = rectangles.filter((rect, i) => !board.nodes[i].manualRect && rect !== working);
        assertClear(allPairs(automatic), label);
        if (working) assertClear(rectangles.filter(rect => rect !== working).map(rect => [working, rect]), label);
      });
    }
  }
}

for (const flow of flows) {
  const label = `manual offsets, flow ${flow}`;
  test(`the working sketch clears offset questions (${label})`, () => {
    const nodes = [idea(143), question('q1', 300, 164), question('q2', 460, 229),
      question('q3', 320, 191, ['q2']), sketch(workingId, 402, 846)];
    const manualOffsets = flow === 'td'
      ? { q1: { dx: 20, dy: 30 }, q2: { dx: 260, dy: 0 }, q3: { dx: 100, dy: 0 } }
      : { q1: { dx: 24, dy: 12 }, q2: { dx: 0, dy: 300 }, q3: { dx: 0, dy: 120 } };
    const workingSketch = { id: workingId, askingIds: ['q1'] };
    const rectangles = placedRectangles({ nodes, flow, constants, manualOffsets, workingSketch }, label);
    const working = rectangles.find(node => node.id === workingId);
    assertClear(rectangles.filter(node => node !== working).map(node => [working, node]), label);
  });
}
