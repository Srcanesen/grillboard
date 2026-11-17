import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserTest as test, browser, serve, stop, until } from './headless-board.mjs';

let commandId = 1000000;
function command(child, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++commandId; let buffer = '';
    const timer = setTimeout(() => finish(new Error('Viewport emulation timed out')), 5000);
    function finish(error, result) { clearTimeout(timer); child.stdio[4].off('data', read); error ? reject(error) : resolve(result); }
    function read(bytes) {
      buffer += bytes.toString(); let index;
      while ((index = buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (message.id === id) finish(message.error && new Error(JSON.stringify(message.error)), message.result);
      }
    }
    child.stdio[4].on('data', read);
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

async function withViewport(width, height, check) {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-canvas-viewport-')), children = [];
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    await writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({ lang: 'en', title: 'Viewport',
      questions: Array.from({ length: 7 }, (_, i) => ({ id: 'q' + (i + 1), title: 'Decision ' + (i + 1), status: 'asking',
        options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] })) }) + ';');
    const url = await serve(root, children), page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && !!currentSession"), 'board');
    const chrome = children.find(child => child.exitCode === null && child.signalCode === null && child.stdio[3]?.writable && child.stdio[4]?.readable);
    assert.ok(chrome, 'A live Chrome process has a CDP pipe');
    const { targetInfos } = await command(chrome, 'Target.getTargets');
    const { sessionId } = await command(chrome, 'Target.attachToTarget', { targetId: targetInfos.find(target => target.url === url).targetId, flatten: true });
    await command(chrome, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 }, sessionId);
    await page.evaluate('specCollapsed = true; updateSpec(); finishMotion(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.deepEqual(await page.evaluate('({ width: innerWidth, height: innerHeight })'), { width, height });
    await check(page);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}

for (const [width, height] of [[1280, 800], [375, 812]]) test(`native focus and scroll cannot shift the canvas at ${width}x${height}`, async () => {
  await withViewport(width, height, async page => {
    for (const fallback of [false, true]) {
      assert.deepEqual(await page.evaluate(`(async () => {
        canvas.style.overflow = ${fallback ? "'hidden'" : "''"};
        const card = nodeRecords.get('q7');
        view = { x: innerWidth + 515 - card.x, y: innerHeight + 65 - card.y, z: 1 }; applyView();
        const editor = card.element.querySelector('.answer-editor'); editor.blur(); editor.focus();
        canvas.scrollLeft += 515; canvas.scrollTop += 65;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { left: canvas.scrollLeft, top: canvas.scrollTop, focused: document.activeElement.dataset.answerQuestion };
      })()`), { left: 0, top: 0, focused: 'q7' });
      assert.deepEqual(await page.evaluate(`(() => {
        focusView(false, ['q7']);
        const box = nodeRecords.get('q7').element.getBoundingClientRect();
        return { left: canvas.scrollLeft, top: canvas.scrollTop,
          inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
      })()`), { left: 0, top: 0, inside: true });
    }
  });
});

test('phone reference errors stay above the visible answers bar as its height changes', async () => {
  await withViewport(375, 812, async page => {
    await page.evaluate(`window.originalFetch = fetch;
      window.fetch = (input, options) => options?.method === 'POST'
        ? Promise.reject(new TypeError('Failed to fetch')) : originalFetch(input, options);
      const transfer = new DataTransfer(); transfer.setData('text/plain', location.origin + '/source');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true }));`);
    await until(() => page.evaluate('!!document.querySelector(".retry-reference")'), 'reference error');
    async function assertAbove() {
      assert.deepEqual(await page.evaluate(`(() => {
        const errors = document.getElementById('reference-add-errors').getBoundingClientRect(), bar = roundBar.getBoundingClientRect();
        return { bothVisible: errors.height > 0 && bar.height > 0 && !roundBar.hidden,
          intersect: errors.left < bar.right && errors.right > bar.left && errors.top < bar.bottom && errors.bottom > bar.top,
          above: errors.bottom <= bar.top };
      })()`), { bothVisible: true, intersect: false, above: true });
    }
    await assertAbove();
    await page.evaluate("nodeRecords.get('q1').element.querySelector('[data-answer-option=a]').click(); document.querySelector('.send-answers').click()");
    await until(() => page.evaluate('!sendingAnswers && !!answerError'), 'answer error expands the bar');
    await assertAbove();
  });
});
