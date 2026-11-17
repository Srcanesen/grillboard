import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { browserTest, until, withBoard } from './headless-board.mjs';
import { loadBlock } from './load-block.mjs';

const questions = [
  { id: 'q8', status: 'settled', title: 'Home layout', decision: 'The home screen shows a list.' },
  { id: 'q9', status: 'asking', title: 'Sign-in' }
];
const working = { id: 'home', src: 'home.html', title: 'Home', rev: 2, width: 320, height: 260 };
const secondary = { ...working, id: 'other', src: 'other.html', title: 'Other', rev: 1 };
const card = '[data-question-id="q8"]';
const control = card + ' .show-in-sketch';
const toggle = '[data-sketch-id="home"] .sketch-toggle';
const iframe = id => `[data-sketch-id="${id}"] iframe`;
const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
const main = query(iframe('home')) + '.contentDocument';
const region = '<p id="first" data-q="Q8"><span>Layout placeholder</span></p>';
const unknown = '<p id="unknown" data-q="Q404">Unknown question</p>';
const geometry = 'getBoundingClientRect().toJSON()';

async function showFrame(page, id) {
  await until(() => page.evaluate('glideFrame === null && motionFrame === null'), 'board settles before measuring the sketch');
  await page.evaluate(`focusView(false, [${JSON.stringify('sketch:' + id)}]);`);
  await until(() => page.evaluate(`!!${query(iframe(id))}?.contentDocument?.querySelector("[data-q]")`), 'sketch regions loaded');
}
async function pointInFrame(page, frameSelector, selector) {
  return page.evaluate(`(() => {
    const frame = ${query(frameSelector)}, box = frame.getBoundingClientRect();
    const rect = frame.contentDocument.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.left + (rect.left + rect.width / 2) * box.width / frame.clientWidth,
      y: box.top + (rect.top + rect.height / 2) * box.height / frame.clientHeight };
  })()`);
}
async function move(page, { x, y }) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
async function click(page, { x, y }) {
  await move(page, { x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const outlined = page => page.evaluate(`[...${main}.querySelectorAll("[data-q]")].filter(
  region => getComputedStyle(region).outlineStyle === "solid").map(region => region.id)`);
const ringed = page => page.evaluate('[...document.querySelectorAll(".sketch-linked")].map(card => card.dataset.questionId)');
const quiet = page => until(() => page.evaluate('glideFrame === null'), 'camera comes to rest');

test('sketch regions are grouped in document order by known question id', () => {
  const { regionsByQuestion } = loadBlock('grill-working-sketch', 'GrillWorkingSketch');
  const tags = [
    { id: 'Q8', region: 'first' }, { id: 'Q404', region: 'unknown' }, { id: 'q8', region: 'second' },
    { id: 'Q08', region: 'separate' }, { id: 'lookup', region: 'custom' },
    { id: 'toString', region: 'inherited' }, { id: '', region: 'empty' }
  ];
  assert.deepEqual([...regionsByQuestion(tags, { q8: {}, Q08: {}, lookup: {}, '': {} })], [
    ['q8', ['first', 'second']], ['Q08', ['separate']], ['lookup', ['custom']]
  ]);
});

browserTest('clicking a nested region in a second sketch glides to its card and rings it until another click', async () => {
  const data = { title: 'Recipe box', questions };
  await withBoard(data, async ({ root, page, session }) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await writeFile(root + '/home.html', '<!doctype html><p>Working sketch</p>');
    await writeFile(root + '/other.html', '<!doctype html>' + region);
    await session({ ...data, sketches: [working, secondary] });
    await showFrame(page, 'other');
    const point = await pointInFrame(page, iframe('other'), '#first span');
    const frame = query(iframe('other'));
    const style = `getComputedStyle(${frame}.contentDocument.querySelector('#first'))`;
    await move(page, point);
    assert.equal(await page.evaluate(`getComputedStyle(${frame}.parentElement).cursor`), 'pointer');
    assert.equal(await page.evaluate(style + '.outlineStyle'), 'solid');
    await move(page, { x: 2, y: 2 });
    assert.equal(await page.evaluate(style + '.outlineStyle'), 'none');
    assert.equal(await page.evaluate('document.querySelectorAll(".show-in-sketch").length'), 0);

    const before = await page.evaluate('({...view})');
    await page.evaluate('document.addEventListener("pointerup", () => { window.linkStartedGlide = glideFrame !== null; }, { once: true })');
    await click(page, point);
    assert.deepEqual(await ringed(page), ['q8']);
    assert.equal(await page.evaluate('linkStartedGlide'), true);
    await quiet(page);
    assert.notDeepEqual(await page.evaluate('({...view})'), before);
    const box = await page.evaluate(query(card) + '.' + geometry);
    const [width, height] = await page.evaluate('[innerWidth, innerHeight]');
    assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height, JSON.stringify(box));
    assert.equal(await page.evaluate(`getComputedStyle(${query(card)}).outlineStyle`), 'solid');
    await click(page, { x: 2, y: 2 });
    assert.deepEqual(await ringed(page), []);
  });
});

browserTest('showing a decision opens the minimized working sketch, scrolls its first region and outlines every match', async () => {
  const data = { lang: 'tr', title: 'Recipe box', questions };
  await withBoard(data, async ({ root, page, session, url }) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await writeFile(root + '/home.html', '<!doctype html><div style="height: 600px"></div>' + region +
      '<p id="second" data-q="q8">Another layout region</p>' + unknown + '<div style="height: 500px"></div>');
    await session({ ...data, sketches: [working] });
    await page.go(url);
    await until(() => page.evaluate(`!!${query(control)}`), 'show in sketch button');
    await page.evaluate('focusView(false, ["q8"]);');
    assert.equal(await page.evaluate(query(control) + '.textContent'), 'Taslakta göster');
    assert.equal(await page.evaluate(query(toggle) + '.getAttribute("aria-expanded")'), 'false');
    await move(page, await page.evaluate(`(() => {
      const {x, y, width, height} = ${query(control)}.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    })()`));
    assert.deepEqual(await outlined(page), []);

    await page.click(control);
    assert.equal(await page.evaluate(query(toggle) + '.getAttribute("aria-expanded")'), 'true');
    assert.deepEqual(await outlined(page), ['first', 'second']);
    assert.equal(await page.evaluate('glideFrame'), null);
    assert.equal(await page.evaluate(`(() => {
      const doc = ${main}, region = doc.querySelector('#first'), box = region.getBoundingClientRect();
      return doc.scrollingElement.scrollTop > 0 && box.top >= 0 && box.bottom <= doc.documentElement.clientHeight;
    })()`), true);
    await click(page, { x: 2, y: 2 });
    assert.deepEqual(await outlined(page), []);
  });
});

browserTest('card hover outlines temporarily and revisions update which cards have controls', async () => {
  const data = { lang: 'en', title: 'Recipe box', questions };
  await withBoard(data, async ({ root, page, session }) => {
    await writeFile(root + '/home.html', '<!doctype html>' + region + '<p id="second" data-q="q8">Second</p>' + unknown);
    await session({ ...data, sketches: [working] });
    await until(() => page.evaluate(`!!${query(control)}`), 'show in sketch button');
    assert.equal(await page.evaluate(query(control) + '.textContent'), 'Show in sketch');
    assert.equal(await page.evaluate('document.querySelectorAll(".show-in-sketch").length'), 1);
    await page.evaluate('focusView(false, ["q8"]);');
    const { x, y, width, height } = await page.evaluate(query(card) + '.' + geometry);
    await move(page, { x: x + width / 2, y: y + height / 2 });
    assert.deepEqual(await outlined(page), ['first', 'second']);
    await move(page, { x: 2, y: 2 });
    assert.deepEqual(await outlined(page), []);

    await showFrame(page, 'home');
    const point = await pointInFrame(page, iframe('home'), '#unknown');
    const before = await page.evaluate('({...view})');
    await move(page, point);
    assert.deepEqual(await outlined(page), []);
    await click(page, point);
    assert.deepEqual(await ringed(page), []);
    assert.equal(await page.evaluate('lightbox.hidden'), true);
    assert.deepEqual(await page.evaluate('({...view})'), before);

    await writeFile(root + '/home.html', '<!doctype html><p data-q="Q9">New sign-in region</p>');
    await session({ ...data, sketches: [{ ...working, rev: 3 }] });
    await until(() => page.evaluate('!!document.querySelector(\'[data-question-id="q9"] .show-in-sketch\')'), 'new region link');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".show-in-sketch")].map(control => control.closest(".question-card").dataset.questionId)'), ['q9']);
  });
});

browserTest('a linked placeholder in an enlarged variant takes the user to its question', async () => {
  const variant = { ...questions[1], options: [{ id: 'a', label: 'Passcode', sketch: 'variant.html', height: 260 }] };
  const data = { lang: 'en', title: 'Recipe box', questions };
  await withBoard(data, async ({ root, page, session }) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await writeFile(root + '/variant.html', '<!doctype html>' + region);
    await session({ ...data, questions: [questions[0], variant] });
    await page.evaluate('focusView(false, ["q9"]);');
    await page.click('.variant-open');
    const frame = query('#lightbox iframe');
    await until(() => page.evaluate(`!!${frame}?.contentDocument?.querySelector('#first')`), 'variant rendered');
    const point = await pointInFrame(page, '#lightbox iframe', '#first span');
    await move(page, point);
    assert.equal(await page.evaluate(`getComputedStyle(${frame}.contentDocument.querySelector('#first span')).cursor`), 'pointer');
    await click(page, point);
    assert.equal(await page.evaluate('lightbox.hidden'), true);
    assert.deepEqual(await ringed(page), ['q8']);
  });
});

for (const mode of ['disk', 'cross-origin']) {
  browserTest(`sketch links are absent without errors in a ${mode} frame`, async () => {
    const data = { title: 'Recipe box', questions };
    await withBoard(data, async ({ root, page, session, url }) => {
      const source = mode === 'disk' ? working.src : new URL(working.src, url.replace('127.0.0.1', 'localhost')).href;
      await writeFile(root + '/home.html', '<!doctype html>' + region);
      if (mode === 'disk') {
        await page.go(pathToFileURL(root + '/index.html').href);
        await until(() => page.evaluate('location.protocol === "file:" && !!document.querySelector(".question-card")'), 'disk board rendered');
      }
      await page.evaluate(`(() => {
        window.sketchErrors = [];
        window.addEventListener('error', event => { if (event.message) sketchErrors.push(event.message); });
        const original = console.error;
        console.error = (...args) => { sketchErrors.push(args.map(String).join(' ')); original(...args); };
      })()`);
      await session({ ...data, sketches: [{ ...working, src: source }] });
      await until(async () => (await page.frameValues('document.querySelector("#first")?.textContent')).includes('Layout placeholder'), 'annotated sketch rendered');
      assert.equal(await page.evaluate('document.querySelectorAll(".show-in-sketch, .sketch-linked").length'), 0);
      assert.deepEqual(await page.frameValues('getComputedStyle(document.querySelector("#first")).outlineStyle'), ['none']);
      assert.deepEqual(await page.evaluate('sketchErrors'), []);
    });
  });
}
