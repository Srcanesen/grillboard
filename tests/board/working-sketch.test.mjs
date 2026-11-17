import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { browserTest, until, withBoard } from './headless-board.mjs';
import { loadBlock } from './load-block.mjs';

const sketch = '.sketch-card[data-sketch-id="main"]';
const toggle = sketch + ' .sketch-toggle';
const frame = sketch + ' .sketch-frame';
const cable = '.connectors path[data-from="@idea"][data-to="sketch:main"]';
const question = { id: 'q1', title: 'Which layout?', status: 'asking', round: 1 };
const mainSketch = { id: 'main', title: 'Home sketch', src: 'main.html', width: 390, height: 760, rev: 1 };
const fixture = () => ({ lang: 'en', title: 'Home', questions: [{ ...question }], sketches: [{ ...mainSketch }] });
const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const position = page => page.evaluate('[' + query(sketch) + '.style.left, ' + query(sketch) + '.style.top]');
const expanded = page => page.evaluate(query(toggle) + '.getAttribute("aria-expanded")');
const still = page => until(() => page.evaluate('glideFrame === null && motionFrame === null'), 'board view settles');
async function viewport(page, width, height = 812) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
const roundFocus = page => page.evaluate('document.querySelector("#toolbar button:nth-of-type(4)").click()');
const fit = page => page.evaluate('document.querySelector("#toolbar button:nth-of-type(3)").click()');
const revealSketch = page => page.evaluate(query(toggle) + '.focus({ preventScroll: true })');
const bounds = (page, selector) => page.evaluate(query(selector) + '.getBoundingClientRect().toJSON()');
function assertInside(box, width, height) {
  assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height, JSON.stringify(box));
}

test('the working sketch follows observed revisions across separate sketch counters', () => {
  const working = loadBlock('grill-working-sketch', 'GrillWorkingSketch');
  const sketch = (rev, id = 'k1') => ({ id, rev });
  const first = sketch(9);
  const second = sketch(1, 'k2');
  const observed = working.observeSketches([first, second], null);
  assert.deepEqual(observed, { sketch: first, observation: { order: [], revisions: { k1: 9, k2: 1 } } });
  const tied = working.observeSketches([first, sketch(9, 'k2')], null);
  assert.equal(tied.sketch.id, 'k2');
  assert.equal(working.observeSketches([sketch(9, 'k2'), first], tied.observation).sketch.id, 'k1');
  const revision = sketch(2, 'k2');
  const revised = working.observeSketches([first, revision], observed.observation);
  assert.equal(revised.sketch.id, 'k2');
  assert.equal(working.observeSketches([first, revision], JSON.parse(JSON.stringify(revised.observation))).sketch.id, 'k2');
  assert.equal(working.observeSketches([sketch(10), sketch(3, 'k2')], revised.observation).sketch.id, 'k1');
  assert.equal(working.observeSketches([sketch(10), sketch(10, 'k2')], revised.observation).sketch.id, 'k2');
});

test('only sketches that changed can win a simultaneous revision poll', () => {
  const working = loadBlock('grill-working-sketch', 'GrillWorkingSketch');
  const unchanged = { id: 'older', rev: 30 };
  const opening = [{ id: 'a', rev: 4 }, { id: 'b', rev: 2 }, unchanged];
  const initial = working.observeSketches(opening, null);
  assert.equal(initial.sketch.id, 'older');
  const advanced = [{ id: 'a', rev: 5 }, { id: 'b', rev: 3 }, unchanged];
  const latest = working.observeSketches(advanced, initial.observation);
  assert.equal(latest.sketch.id, 'a');
  assert.equal(working.observeSketches(advanced, latest.observation).sketch.id, 'a');
  assert.equal(working.observeSketches([{ id: 'a', rev: 6 }, unchanged, { id: 'b', rev: 6 }], latest.observation).sketch.id, 'b');
  assert.equal(working.observeSketches(advanced.slice(1), latest.observation).sketch.id, 'b');
});

browserTest('a dragged working sketch holds its position until the next round', async () => {
  const data = fixture();
  await withBoard(data, async ({ page, url, session }) => {
    const start = await position(page);
    await revealSketch(page);
    await page.drag(sketch, 70, 40);
    const dragged = await position(page);
    assert.notDeepEqual(dragged, start);
    data.questions[0].body = 'A clarification for the same round';
    await session(data);
    assert.deepEqual(await position(page), dragged);
    await page.go(url);
    await until(() => page.evaluate('!!' + query(sketch)), 'dragged sketch after reload');
    assert.deepEqual(await position(page), dragged);
    data.questions[0].round = 2;
    await session(data);
    assert.deepEqual(await position(page), start);
    assert.equal(await page.evaluate(query(cable) + '.dataset.to'), 'sketch:main');
  });
});

browserTest('a wide board opens the sketch and saves the chip state across reloads', async () => {
  await withBoard(fixture(), async ({ root, page, url }) => {
    const spot = await position(page);
    assert.equal(await expanded(page), 'true');
    assert.equal(await page.evaluate(query(toggle) + '.getAttribute("aria-label")'), 'Minimize sketch');
    await revealSketch(page);
    await page.click(toggle);
    assert.equal(await expanded(page), 'false');
    assert.equal(await page.evaluate(query(sketch + ' strong') + '.textContent'), 'Home sketch');
    assert.equal(await page.evaluate(query(frame) + '.getBoundingClientRect().width'), 0);
    assert.equal(await page.evaluate(query(cable) + '.dataset.to'), 'sketch:main');
    assert.deepEqual(await position(page), spot);

    await page.go(url);
    await until(() => page.evaluate('!!' + query(toggle)), 'sketch after reload');
    assert.equal(await expanded(page), 'false');
    await revealSketch(page);
    await page.click(sketch + ' strong');
    await still(page);
    assert.equal(await expanded(page), 'true');
    assert.ok(await page.evaluate(query(frame) + '.getBoundingClientRect().width') > 0);
    assert.deepEqual(await position(page), spot);

    await page.go(url);
    await until(() => page.evaluate('!!' + query(toggle)), 'restored open sketch after reload');
    assert.equal(await expanded(page), 'true');
    await revealSketch(page);
    await page.click(toggle);
    await writeFile(root + '/other.js', 'window.__GRILL__ = ' + JSON.stringify(fixture()) + ';');
    await page.go(url + '?session=other.js');
    await until(() => page.evaluate('!!' + query(toggle)), 'same sketch id in another session');
    assert.equal(await expanded(page), 'true');
  });
});

browserTest('a revision marks the minimized sketch until it is opened', async () => {
  const data = { ...fixture(), lang: 'tr' };
  const mark = 'getComputedStyle(' + query(sketch) + ', "::after").content';
  await withBoard(data, async ({ root, page, url, session }) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await revealSketch(page);
    await page.click(toggle);
    assert.equal(await page.evaluate(mark), 'none');
    assert.equal(await page.evaluate(query(toggle) + '.getAttribute("aria-label")'), 'Taslağı aç');
    await writeFile(root + '/main.html', '<!doctype html><p>New sketch content</p>');
    data.sketches[0].rev = 2;
    await session(data);
    assert.equal(await expanded(page), 'false');
    assert.equal(await page.evaluate(mark), '"Yeni"');
    assert.equal(await page.evaluate('getComputedStyle(' + query(sketch) + ').animationName'), 'unseen-pulse');
    data.title = 'An unrelated edit';
    await session(data);
    await page.go(url);
    await until(() => page.evaluate('!!' + query(toggle)), 'minimized sketch after reload');
    assert.equal(await page.evaluate(mark), '"Yeni"');

    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await page.evaluate('getComputedStyle(' + query(sketch) + ').animationName'), 'none');
    assert.equal(await page.evaluate(mark), '"Yeni"');
    await page.evaluate(query(toggle) + '.focus()');
    await page.key('Enter');
    assert.equal(await expanded(page), 'true');
    assert.equal(await page.evaluate(mark), 'none');
    await until(() => page.evaluate(query(frame + ' iframe') + '.srcdoc.includes("New sketch content")'), 'current sketch loads');
  });
});

browserTest('a sketch-free phone board adds no controls and the first sketch opens at readable width on demand', async () => {
  const data = fixture(); data.sketches = [];
  await withBoard(data, async ({ page, session }) => {
    await viewport(page, 375);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await page.evaluate('document.querySelectorAll(".sketch-card, .sketch-toggle").length'), 0);
    data.sketches = [{ ...mainSketch }];
    await session(data);
    await still(page);
    assert.equal(await expanded(page), 'false');
    assert.equal(await page.evaluate(query(frame) + '.getBoundingClientRect().width'), 0);
    await page.evaluate('document.querySelector("#spec-toggle").click()');
    assert.equal(await page.evaluate('Math.round(document.querySelector("#spec-panel").getBoundingClientRect().height)'), 487);
    await roundFocus(page);
    await revealSketch(page);
    await page.click(toggle);
    await still(page);
    assert.equal(await expanded(page), 'true');
    const box = await page.evaluate(query(frame) + '.getBoundingClientRect().toJSON()');
    assert.ok(box.width >= 280, 'Sketch frame width is ' + box.width);
    assert.ok(box.left >= 0 && box.right <= 375 && box.top >= 0 && box.bottom <= 812, JSON.stringify(box));
  });
});

browserTest('a new phone chip respects the idle view rule and keeps the active asking card visible', async () => {
  const data = fixture(); data.sketches = [];
  data.questions.push({ ...question, id: 'q2', title: 'Which details?' });
  await withBoard(data, async ({ page, url, session }) => {
    await viewport(page, 375);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.go(url);
    await until(() => page.evaluate('!!' + query('.question-card.asking')), 'phone board without sketches');
    const initialView = await page.evaluate('({...view})');
    await page.evaluate(`(() => {
      window.testNow = Date.now(); Date.now = () => testNow;
      const button = ${query('.round-count')};
      button.click(); button.click();
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 20, cancelable: true }));
      testNow += 10000;
      ${query('[data-question-id="q2"] .answer-editor')}.focus({ preventScroll: true });
    })()`);
    await page.type('Draft');
    assert.equal(await page.evaluate(query('[data-question-id="q2"] .answer-editor') + '.value'), 'Draft');
    const activeView = await page.evaluate('({...view})');
    await page.evaluate('testNow += 9999');
    data.sketches = [{ ...mainSketch }];
    await session(data);
    await still(page);
    assert.equal(await expanded(page), 'false');
    assert.deepEqual(await page.evaluate('({...view})'), activeView, 'a sketch arriving before ten idle seconds leaves the camera in place');

    await page.evaluate('testNow += 1');
    await session(data);
    assert.deepEqual(await page.evaluate('({...view})'), activeView, 'an unchanged poll does not replay the arrival');
    await session({ ...data, sketches: [] });
    await session(data);
    await still(page);
    assert.notDeepEqual(await page.evaluate('({...view})'), activeView, 'a new arrival after ten idle seconds can move the view');
    assert.equal(await page.evaluate(query('[data-question-id="q2"]') + '.getAttribute("aria-selected")'), 'true');
    const card = await bounds(page, '[data-question-id="q2"]');
    const top = (await bounds(page, '#header')).bottom;
    const bottom = (await bounds(page, '#round-bar')).top;
    const visibleWidth = Math.max(0, Math.min(375, card.right) - Math.max(0, card.left));
    const visibleHeight = Math.max(0, Math.min(bottom, card.bottom) - Math.max(top, card.top));
    assert.ok(visibleWidth * visibleHeight >= card.width * card.height / 2, JSON.stringify(card));

    await page.go(url);
    await until(() => page.evaluate('!!' + query(toggle)), 'phone chip after reload');
    assert.equal(await expanded(page), 'false');
    assert.deepEqual(await page.evaluate('({...view})'), initialView, 'loading a sketch adds no initial camera move');
  });
});

browserTest('Fit includes the whole chip and repeats the same view at 300px', async () => {
  const data = fixture(); data.sketches = [];
  await withBoard(data, async ({ page, session }) => {
    await viewport(page, 300);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    data.sketches = [{ ...mainSketch }];
    await session(data);
    assert.equal(await expanded(page), 'false');
    await fit(page);
    const first = await page.evaluate('({...view})');
    const button = await bounds(page, toggle);
    await fit(page);
    assert.deepEqual(await page.evaluate('({...view})'), first, 'a second Fit yields the same camera position and zoom');
    assertInside(button, 300, 812);
    assertInside(await bounds(page, sketch), 300, 812);
  });
});

browserTest('round focus preserves the asking-card zoom and includes a sketch that fits at that zoom', async () => {
  const data = fixture(); data.sketches = [];
  data.questions[0].options = [{ id: 'a', label: 'Grid' }];
  await withBoard(data, async ({ page, session }) => {
    await viewport(page, 1440, 900);
    await roundFocus(page);
    const baselineZoom = await page.evaluate('view.z');
    assert.equal(baselineZoom, 1);

    data.sketches = [{ ...mainSketch, height: 2300 }];
    await session(data);
    await roundFocus(page);
    assert.equal(await page.evaluate('view.z'), baselineZoom);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".option")).visibility'), 'visible');

    data.sketches[0].height = 275;
    await session(data);
    await roundFocus(page);
    assert.equal(await page.evaluate('view.z'), 1);
    assert.ok(await page.evaluate(`(() => {
      const box = ${query(frame)}.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.querySelector('#spec-panel').getBoundingClientRect().left &&
        box.top >= 0 && box.bottom <= innerHeight;
    })()`));
  });
});

browserTest('phone opening fits the target width even for a resized sketch', async () => {
  await withBoard(fixture(), async ({ page }) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.evaluate(`(() => {
      const handle = ${query(sketch + ' .resize-ne')};
      for (let i = 0; i < 11; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    })()`);
    assert.equal(await page.evaluate(query(frame) + '.style.width'), '160px');
    for (const [width, expected] of [[280, 256], [304, 280], [375, 280]]) {
      await viewport(page, width);
      await page.evaluate(query(toggle) + '.click()');
      await page.evaluate(query(toggle) + '.click()');
      const box = await page.evaluate(query(frame) + '.getBoundingClientRect().toJSON()');
      const visibleWidth = Math.min(width, box.right) - Math.max(0, box.left);
      assert.ok(Math.abs(visibleWidth - expected) < .03, `Expected ${expected}px visible at ${width}px, got ${visibleWidth}px`);
      assert.ok(box.left >= 0 && box.right <= width, JSON.stringify(box));
    }
  });
});

browserTest('a short sketch opens at 280px or the viewport width minus 24px on phones', async () => {
  const data = fixture();
  data.sketches = [{ ...mainSketch, width: 800, height: 200 }];
  await withBoard(data, async ({ page }) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const [width, expected] of [[280, 256], [303, 279], [304, 280], [375, 280], [599, 280]]) {
      await viewport(page, width);
      await page.evaluate(query(toggle) + '.click()');
      await page.evaluate(query(toggle) + '.click()');
      const box = await bounds(page, frame);
      assert.ok(Math.abs(box.width - expected) < .03, JSON.stringify({ width, expected, actual: box.width }));
      assertInside(box, width, 812);
    }
  });
});

browserTest('the minimize button and chip keep readable dimensions at 55% and in the far view', async () => {
  await withBoard(fixture(), async ({ page }) => {
    const measure = (z, selector) => page.evaluate(`(() => {
      zoomAt(${z}, innerWidth / 2, innerHeight / 2);
      const node = ${query(selector)};
      const { width, height } = node.getBoundingClientRect();
      return { width, height, font: parseFloat(getComputedStyle(node).fontSize) * view.z };
    })()`);
    const compare = async selector => {
      const baseline = await measure(1, selector);
      for (const z of [.55, .4]) {
        const actual = await measure(z, selector);
        for (const dimension of ['width', 'height', 'font']) {
          assert.ok(actual[dimension] >= baseline[dimension] * .95, `${selector} ${dimension} at ${z}: ${actual[dimension]}`);
        }
      }
    };
    await compare(toggle);
    await page.evaluate(query(toggle) + '.click()');
    await compare(sketch + ' strong');
    await compare(toggle);
    assert.ok((await measure(.55, sketch)).width >= 219);
  });
});
