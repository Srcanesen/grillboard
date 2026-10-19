import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserTest as test, serve, stop, until } from './headless-board.mjs';
import { inputBrowser } from './input-board.mjs';

for (const activation of ['pointer', 'keyboard']) for (const trigger of ['answer click', 'card drag']) test('a variant button works by ' + activation + ' immediately after an independent ' + trigger, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-click-'));
  const children = [];
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    await writeFile(path.join(root, 'sketch.html'), '<html><body>Variant</body></html>');
    await writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({ questions: [
      { id: 'q1', title: 'Storage?', status: 'asking', options: [{ id: 'a', label: 'Files', sketch: 'sketch.html', width: 400, height: 300 }] }
    ] }) + ';\n');
    const url = await serve(root, children);
    const page = await inputBrowser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate('typeof currentSession !== "undefined" && !!currentSession'), 'board render');
    await page.evaluate('finishMotion(); focusView(false, ["q1"]); window.deliveredClicks = 0; canvas.addEventListener("click", () => deliveredClicks++, true)');
    if (trigger === 'answer click') {
      await page.click('.option-label');
      assert.equal(await page.evaluate('document.querySelector("[data-answer-option=a]").getAttribute("aria-checked")'), 'true');
    } else {
      await page.drag('.question-title', 12, 8);
      assert.deepEqual(await page.evaluate('({dx: Math.round(manualOffsets.q1.dx * view.z), dy: Math.round(manualOffsets.q1.dy * view.z)})'), { dx: 12, dy: 8 });
    }
    assert.equal(await page.evaluate('deliveredClicks'), 0, 'The completed gesture does not deliver a duplicate click');
    if (activation === 'pointer') await page.click('.variant-open');
    else {
      await page.evaluate('document.querySelector(".variant-open").focus()');
      await page.key('Enter');
    }
    assert.equal(await page.evaluate('lightbox.hidden'), false, 'The independent button opens its sketch without waiting 500 ms');
    assert.equal(await page.evaluate('deliveredClicks'), 1, 'The independent activation delivers exactly one click');
    assert.equal(await page.evaluate('document.querySelector("[data-answer-option=a]").getAttribute("aria-checked")'), trigger === 'answer click' ? 'true' : 'false');
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
