import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBlock } from './load-block.mjs';

const camera = loadBlock('grill-camera', 'GrillCamera');
const screen = (overrides = {}) => ({
  width: 1000, height: 800, boardHidden: false,
  header: { right: 0, bottom: 0 }, toolbar: { right: 0, top: 800 },
  roundBar: null, specPanel: null, ...overrides,
});
function assertView(actual, expected) {
  for (const key of ['x', 'y', 'z']) {
    assert.ok(Number.isFinite(actual?.[key]), `missing finite ${key}`);
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9,
      `${key}: expected ${expected[key]}, got ${actual[key]}`);
  }
}

test('fit centres the bounds, including the 28 pixel space above cards, at zoom 1', () => {
  assertView(camera.fit([{ x: 100, y: 200, width: 200, height: 100 }], screen()),
    { x: 300, y: 164, z: 1 });
});

test('fit zooms a wide tree out', () => {
  assertView(camera.fit([{ x: 0, y: 0, width: 2000, height: 100 }], screen()),
    { x: 40, y: 383.44, z: .46 });
});

test('fit clamps zoom to .1 and 1 even for extreme bounds', () => {
  assertView(camera.fit([{ x: 0, y: 0, width: 10000, height: 10000 }], screen()),
    { x: 0, y: -98.6, z: .1 });
  assertView(camera.fit([{ x: 0, y: 0, width: 1, height: 1 }], screen()),
    { x: 499.5, y: 413.5, z: 1 });
});

test('header strip is surrendered only when a card would land beneath it', () => {
  const display = screen({ header: { right: 200, bottom: 100 } });
  assertView(camera.fit([{ x: 0, y: 0, width: 900, height: 692 }], display),
    { x: 117.5, y: 171.8, z: .85 });
  assertView(camera.fit([{ x: 0, y: 0, width: 500, height: 692 }], display),
    { x: 250, y: 68, z: 1 });
});

test('toolbar regression: a full-area fit is retried above the toolbar', () => {
  const display = screen({ toolbar: { right: 200, top: 700 } });
  const result = camera.fit([{ x: 0, y: 0, width: 900, height: 692 }], display);
  assertView(result, { x: 117.5, y: 63.8, z: .85 });
  assert.ok(result.y + 692 * result.z <= 692);
  assertView(camera.fit([{ x: 0, y: 0, width: 500, height: 692 }], display),
    { x: 250, y: 68, z: 1 });
});

test('header is rechecked after surrendering the toolbar strip', () => {
  assertView(camera.fit([{ x: 0, y: 0, width: 900, height: 600 }], screen({
    header: { right: 200, bottom: 100 }, toolbar: { right: 200, top: 700 },
  })), { x: 138.85350318471342, y: 170.47133757961782, z: .802547770700637 });
});

test('round bar takes the bottom strip on wide and narrow screens', () => {
  const boxes = [{ x: 0, y: 0, width: 200, height: 100 }];
  assertView(camera.fit(boxes, screen({ roundBar: { top: 608 } })),
    { x: 400, y: 264, z: 1 });
  assertView(camera.fit(boxes, screen({ width: 390, height: 844,
    header: { right: 200, bottom: 100 }, roundBar: { top: 608 } })),
    { x: 95, y: 318, z: 1 });
});

test('spec panel reserves the right side on wide screens and bottom on narrow screens', () => {
  const boxes = [{ x: 0, y: 0, width: 200, height: 100 }];
  assertView(camera.fit(boxes, screen({ specPanel: { left: 800, top: 508 } })),
    { x: 300, y: 364, z: 1 });
  const narrow = screen({ width: 390, height: 844, header: { right: 200, bottom: 100 } });
  assertView(camera.fit(boxes, { ...narrow, specPanel: { left: 16, top: 508 } }),
    { x: 95, y: 272, z: 1 });
  assertView(camera.fit(boxes, narrow), { x: 95, y: 440, z: 1 });
});

test('round bar and spec panel use the nearer bottom edge', () => {
  assertView(camera.fit([{ x: 0, y: 0, width: 200, height: 100 }], screen({
    width: 390, height: 844, header: { right: 200, bottom: 100 },
    specPanel: { left: 16, top: 508 }, roundBar: { top: 408 },
  })), { x: 95, y: 218, z: 1 });
});

test('a hidden board keeps the full height even on a narrow screen', () => {
  assertView(camera.fit([{ x: 0, y: 0, width: 100, height: 100 }], screen({
    width: 390, height: 844, boardHidden: true, header: { right: 0, bottom: 100 },
  })), { x: 145, y: 386, z: 1 });
});

test('focus enforces .7 and .4 and aligns oversized boxes at the top or top left', () => {
  const boxes = [{ x: 100, y: 200, width: 2000, height: 2000 }];
  assertView(camera.focus(boxes, screen(), { minimum: .7 }), { x: -54, y: -116, z: .7 });
  assertView(camera.focus(boxes, screen(), { minimum: .4 }), { x: 60, y: -56, z: .4 });
});

test('focus drops from the end until the prefix fits and retains overflow top alignment', () => {
  const boxes = [
    { x: 100, y: 200, width: 100, height: 100 },
    { x: 400, y: 500, width: 100, height: 100 },
    { x: 2000, y: 2000, width: 100, height: 100 },
    { x: -3000, y: -3000, width: 100, height: 100 },
  ];
  assertView(camera.focus(boxes, screen(), { minimum: .7 }), { x: 200, y: -176, z: 1 });
  assert.deepEqual(boxes, [
    { x: 100, y: 200, width: 100, height: 100 },
    { x: 400, y: 500, width: 100, height: 100 },
    { x: 2000, y: 2000, width: 100, height: 100 },
    { x: -3000, y: -3000, width: 100, height: 100 },
  ]);
});

test('focus centres boxes that fit without exceeding zoom 1', () => {
  assertView(camera.focus([{ x: 100, y: 200, width: 200, height: 100 }], screen(), { minimum: .7 }),
    { x: 300, y: 150, z: 1 });
});

test('focus applies header and toolbar avoidance to the kept prefix', () => {
  assertView(camera.focus([{ x: 0, y: 0, width: 900, height: 692 }], screen({
    header: { right: 200, bottom: 100 }, toolbar: { right: 200, top: 700 },
  }), { minimum: .4 }), { x: 172.2543352601156, y: 148, z: .7283236994219653 });
});

test('isFar changes at .5', () => {
  assert.equal(camera.isFar(.49), true);
  assert.equal(camera.isFar(.5), false);
});

// Literal geometry and targets recorded in Chrome before the extraction.
const activeBoxes = [
  {"x": -190, "y": 0, "width": 380, "height": 143},
  {"x": -702, "y": 207, "width": 300, "height": 164},
  {"x": 74, "y": 207, "width": 300, "height": 129},
  {"x": 402, "y": 207, "width": 300, "height": 191},
  {"x": -1070, "y": 725, "width": 300, "height": 229},
  {"x": 74, "y": 725, "width": 300, "height": 270},
  {"x": -742, "y": 725, "width": 300, "height": 149},
  {"x": -414, "y": 725, "width": 460, "height": 559},
  {"x": -1070, "y": 1348, "width": 300, "height": 140},
  {"x": 726, "y": 207, "width": 200, "height": 221},
  {"x": 726, "y": 440, "width": 200, "height": 221},
  {"x": -1390, "y": 0, "width": 200, "height": 105},
  {"x": -1390, "y": 157, "width": 240, "height": 90},
  {"x": 74, "y": 344, "width": 300, "height": 56},
  {"x": -201, "y": -902, "width": 402, "height": 846},
];
const doneBoxes = [
  {"x": -190, "y": 0, "width": 380, "height": 143},
  {"x": -702, "y": 207, "width": 300, "height": 164},
  {"x": 74, "y": 207, "width": 300, "height": 129},
  {"x": 402, "y": 207, "width": 300, "height": 191},
  {"x": -1070, "y": 725, "width": 300, "height": 109},
  {"x": 74, "y": 725, "width": 300, "height": 109},
  {"x": -742, "y": 725, "width": 300, "height": 109},
  {"x": -414, "y": 725, "width": 460, "height": 109},
  {"x": -1070, "y": 898, "width": 300, "height": 129},
  {"x": 726, "y": 207, "width": 200, "height": 221},
  {"x": 726, "y": 440, "width": 200, "height": 221},
  {"x": -1390, "y": 0, "width": 200, "height": 105},
  {"x": -1390, "y": 157, "width": 240, "height": 90},
  {"x": 74, "y": 344, "width": 300, "height": 56},
  {"x": -201, "y": -902, "width": 402, "height": 846},
];
const baselineFits = [
  { name: "active/1280x800/open/fit", boxes: activeBoxes,
    screen: {"width": 1280, "height": 800, "boardHidden": false, "header": {"right": 436, "bottom": 125.25}, "toolbar": {"right": 270.234375, "top": 737}, "roundBar": {"top": 728.5}, "specPanel": {"left": 904, "top": 16}},
    expected: {"x": 513.4540942928039, "y": 286.34615384615387, "z": 0.2648883374689826} },
  { name: "active/1280x800/collapsed/fit", boxes: activeBoxes,
    screen: {"width": 1280, "height": 800, "boardHidden": false, "header": {"right": 436, "bottom": 125.25}, "toolbar": {"right": 270.234375, "top": 737}, "roundBar": {"top": 728.5}, "specPanel": null},
    expected: {"x": 701.4540942928039, "y": 286.34615384615387, "z": 0.2648883374689826} },
  { name: "active/390x844/open/fit", boxes: activeBoxes,
    screen: {"width": 390, "height": 844, "boardHidden": false, "header": {"right": 374, "bottom": 86.25}, "toolbar": {"right": 270.234375, "top": 266.609375}, "roundBar": {"top": 170.609375}, "specPanel": {"left": 16, "top": 321.609375}},
    expected: {"x": 218.2, "y": 100.5296875, "z": 0.1} },
  { name: "active/390x844/collapsed/fit", boxes: activeBoxes,
    screen: {"width": 390, "height": 844, "boardHidden": false, "header": {"right": 374, "bottom": 86.25}, "toolbar": {"right": 270.234375, "top": 781}, "roundBar": {"top": 685}, "specPanel": null},
    expected: {"x": 226.05354058721935, "y": 348.2804404145078, "z": 0.13385146804835923} },
  { name: "done/1280x800/open/fit", boxes: doneBoxes,
    screen: {"width": 1280, "height": 800, "boardHidden": false, "header": {"right": 436, "bottom": 125.25}, "toolbar": {"right": 270.234375, "top": 737}, "roundBar": null, "specPanel": {"left": 904, "top": 16}},
    expected: {"x": 528.9381706693919, "y": 348.4159427695452, "z": 0.3316300459887583} },
  { name: "done/1280x800/collapsed/fit", boxes: doneBoxes,
    screen: {"width": 1280, "height": 800, "boardHidden": false, "header": {"right": 436, "bottom": 125.25}, "toolbar": {"right": 270.234375, "top": 737}, "roundBar": null, "specPanel": null},
    expected: {"x": 725.3551354113439, "y": 382.156361778232, "z": 0.36791006642820645} },
  { name: "done/390x844/open/fit", boxes: doneBoxes,
    screen: {"width": 390, "height": 844, "boardHidden": false, "header": {"right": 374, "bottom": 86.25}, "toolbar": {"right": 270.234375, "top": 266.609375}, "roundBar": null, "specPanel": {"left": 16, "top": 321.609375}},
    expected: {"x": 218.2, "y": 171.5796875, "z": 0.1} },
  { name: "done/390x844/collapsed/fit", boxes: doneBoxes,
    screen: {"width": 390, "height": 844, "boardHidden": false, "header": {"right": 374, "bottom": 86.25}, "toolbar": {"right": 270.234375, "top": 781}, "roundBar": null, "specPanel": null},
    expected: {"x": 226.05354058721935, "y": 462.63320379965455, "z": 0.13385146804835923} },
];
for (const sample of baselineFits) {
  test(`browser baseline fit: ${sample.name}`, () => {
    assertView(camera.fit(sample.boxes, sample.screen), sample.expected);
  });
}

const reportBoxes = [
  { x: 74, y: 207, width: 300, height: 129 },
  { x: 74, y: 344, width: 300, height: 56 },
];

test("browser baseline focus with a report: active/1280x800/open/q2", () => {
  assertView(camera.focus(reportBoxes, baselineFits[0].screen, { minimum: .4 }),
    {"x": 228, "y": 56.75, "z": 1});
});

test("browser baseline focus with a report: active/390x844/open/q2", () => {
  assertView(camera.focus(reportBoxes, baselineFits[2].screen, { minimum: .4 }),
    {"x": 105.39999999999999, "y": 35.44999999999999, "z": 0.4});
});
