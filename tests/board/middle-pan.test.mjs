import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const data = {
  idea: 'A recipe box',
  questions: [{ id: 'q1', title: 'Storage?', status: 'asking', options: [
    { id: 'a', label: 'Files' }, { id: 'b', label: 'Database' }
  ] }],
  refs: [{ id: 'guide', src: 'guide.html', caption: 'Storage guide' }]
};
const point = { x: 350, y: 250 };
const viewDelta = `(() => {
  const { m41, m42, a } = new DOMMatrix(getComputedStyle(world).transform);
  return [m41 - startView.x, m42 - startView.y, a];
})()`;

async function mouse(page, type, dx = 0, dy = 0) {
  await page.send('Input.dispatchMouseEvent', {
    type, x: point.x + dx, y: point.y + dy, button: 'middle',
    buttons: type === 'mouseReleased' ? 0 : 4, clickCount: 1
  });
}

async function centerOn(page, selector, hitSelector = selector) {
  await page.evaluate(`(() => {
    finishMotion();
    glideView({ x: 2000, y: 2000, z: .8 }, false);
    const selector = ${JSON.stringify(selector)};
    if (selector) {
      const box = document.querySelector(selector).getBoundingClientRect();
      view.x += Math.round(${point.x} - box.left - box.width / 2);
      view.y += Math.round(${point.y} - box.top - box.height / 2);
      applyView();
    }
    window.startView = { ...view };
  })()`);
  assert.equal(await page.evaluate(
    `document.elementFromPoint(${point.x}, ${point.y}).matches(${JSON.stringify(hitSelector || '#canvas')})`
  ), true);
}

test('middle-drag pans the board from empty space, a question and the area of a sketch iframe', async () => {
  await withBoard(data, async ({ root, page, session }) => {
    await writeFile(path.join(root, 'home.html'), '<!doctype html><p data-q="q1">Storage</p>');
    await session({ ...data, sketches: [{ id: 'home', title: 'Home', src: 'home.html', width: 340, height: 280 }] });
    await until(() => page.evaluate('!!document.querySelector(".sketch-card iframe")?.contentDocument?.querySelector("[data-q]")'), 'sketch document loaded');
    await page.evaluate('chooseAnswer("q1", "a"); document.activeElement.blur()');

    for (const [selector, hit] of [[null, null], ['[data-answer-option="b"] .option-label'], ['.answer-editor'],
      ['.sketch-card iframe', '.sketch-card .sketch-frame'], ['.question-card .resize-se']]) {
      await centerOn(page, selector, hit);
      await page.evaluate(`window.startNodes = [...nodeRecords.values()].map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))`);
      await mouse(page, 'mousePressed');
      assert.equal(await page.evaluate(`getComputedStyle(document.elementFromPoint(${point.x}, ${point.y})).cursor`), 'grabbing');
      await mouse(page, 'mouseMoved', 32, -24);
      await mouse(page, 'mouseReleased', 32, -24);

      assert.deepEqual(await page.evaluate(viewDelta), [32, -24, .8]);
      assert.deepEqual(await page.evaluate(`startNodes.map(({ id, x, y, width, height }) => {
        const node = nodeRecords.get(id);
        return [node.x - x, node.y - y, node.width - width, node.height - height];
      })`), [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
      assert.equal(await page.evaluate('document.querySelector(".question-card").getAttribute("aria-selected")'), 'false');
      assert.deepEqual(await page.evaluate('answerDrafts.get("q1")'), { option: 'a', text: '' });
      assert.equal(await page.evaluate('document.activeElement.tagName'), 'BODY');
      assert.equal(await page.evaluate('lightbox.hidden'), true);
      assert.equal(await page.evaluate('getComputedStyle(canvas).cursor'), 'grab');
    }
  });
});

test('a moved middle pan cancels link navigation and a stationary middle click opens the link', async () => {
  await withBoard(data, async ({ root, url, page }) => {
    await writeFile(path.join(root, 'guide.html'), '<!doctype html><title>Storage guide</title>');
    const target = new URL('guide.html', url).href;
    const opened = async () => (await page.send('Target.getTargets')).targetInfos.filter(info => info.url === target).length;
    await centerOn(page, '.ref-open');
    await page.evaluate('document.addEventListener("auxclick", event => { window.lastAuxClick = event; }, true)');
    await mouse(page, 'mousePressed');
    await mouse(page, 'mouseMoved', 28, 16);
    await mouse(page, 'mouseReleased', 28, 16);
    assert.deepEqual(await page.evaluate(viewDelta), [28, 16, .8]);
    assert.equal(await page.evaluate('window.lastAuxClick?.defaultPrevented'), true);
    assert.equal(await opened(), 0);

    await centerOn(page, '.ref-open');
    await mouse(page, 'mousePressed');
    await mouse(page, 'mouseReleased');
    assert.deepEqual(await page.evaluate(viewDelta), [0, 0, .8]);
    assert.equal(await page.evaluate('window.lastAuxClick?.defaultPrevented'), false);
    await until(async () => await opened() === 1, 'middle click opens one new tab');
    assert.equal(await opened(), 1);
  });
});

test('pointer cancellation and window blur release middle pan capture', async () => {
  await withBoard(data, async ({ page }) => {
    await page.evaluate('document.addEventListener("pointerdown", event => { window.panPointerId = event.pointerId; }, true)');
    for (const cancel of ['canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: panPointerId }))',
      'window.dispatchEvent(new Event("blur"))']) {
      await centerOn(page, null);
      await mouse(page, 'mousePressed');
      await mouse(page, 'mouseMoved', 30, 20);
      assert.equal(await page.evaluate('canvas.hasPointerCapture(panPointerId)'), true);
      await page.evaluate(cancel);
      assert.equal(await page.evaluate('canvas.hasPointerCapture(panPointerId)'), false);
      assert.equal(await page.evaluate('getComputedStyle(canvas).cursor'), 'grab');
      await mouse(page, 'mouseMoved', 60, 40);
      await mouse(page, 'mouseReleased', 60, 40);
      assert.deepEqual(await page.evaluate(viewDelta), [30, 20, .8]);
    }
  });
});

test('session updates keep the view in place during a middle pan and for ten seconds after release', async () => {
  await withBoard(data, async ({ page, session }) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.evaluate('window.boardClock = Date.now(); Date.now = () => boardClock');
    await centerOn(page, null);
    await mouse(page, 'mousePressed');
    await mouse(page, 'mouseMoved', 32, -24);
    await page.evaluate('boardClock += 20000');
    const questions = [...data.questions, { id: 'q2', title: 'Sync?', status: 'asking' }];
    await session({ ...data, questions });
    assert.deepEqual(await page.evaluate(viewDelta), [32, -24, .8]);
    await mouse(page, 'mouseReleased', 32, -24);
    assert.equal(await page.evaluate(`document.querySelector('[data-question-id="q2"] .question-title').textContent`), 'Sync?');

    await page.evaluate('boardClock += 9999');
    questions.push({ id: 'q3', title: 'Sharing?', status: 'asking' });
    await session({ ...data, questions });
    assert.equal(await page.evaluate(`document.querySelector('[data-question-id="q3"] .question-title').textContent`), 'Sharing?');
    assert.deepEqual(await page.evaluate(viewDelta), [32, -24, .8]);
  });
});
