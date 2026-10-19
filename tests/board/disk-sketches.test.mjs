import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserTest as test, stop, until } from './headless-board.mjs';
import { inputBrowser } from './input-board.mjs';

test('disk sketches preserve input on unrelated saves and refresh when their own path or revision changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-disk-sketch-'));
  const children = [];
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    const data = { title: 'Before', questions: [{ id: 'q1', title: 'Storage?', status: 'asking',
      options: [{ id: 'a', label: 'Files', sketch: 'option.html' }] }] };
    const save = () => writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify(data) + ';\n');
    await writeFile(path.join(root, 'option.html'), '<html><body>Before sketch<input style="position:fixed;inset:0;width:100%;height:100%"></body></html>');
    await save();
    const page = await inputBrowser(path.join(root, 'chrome-profile'), children);
    await page.go(pathToFileURL(path.join(root, 'index.html')).href);
    await until(() => page.evaluate('typeof currentSession !== "undefined" && !!currentSession'), 'disk render');
    await page.evaluate('document.querySelector(".variant-open").focus(); document.querySelector(".variant-open").click()');
    await until(async () => (await page.frameValues('document.body.textContent')).filter(text => text === 'Before sketch').length === 2, 'two initial sketches');
    await until(async () => {
      await page.click('#lightbox iframe');
      return (await page.frameValues('document.hasFocus() && document.activeElement.tagName === "INPUT"')).some(Boolean);
    }, 'focus the sketch input');
    await page.type('hello');
    await page.evaluate(`window.diskSketchLoads = 0; window.originalSketchFrames = [...document.querySelectorAll('iframe')];
      document.addEventListener('load', event => { if (event.target.tagName === 'IFRAME') diskSketchLoads++; }, true);`);
    data.title = 'Unrelated save'; await save(); await page.evaluate('loadFiles()');
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    assert.equal(await page.evaluate('diskSketchLoads'), 0, 'Unchanged preview and dialog documents do not reload');
    assert.deepEqual((await page.frameValues('document.querySelector("input")?.value')).sort(), ['', 'hello']);
    assert.equal(await page.evaluate('originalSketchFrames.every((frame, index) => frame === document.querySelectorAll("iframe")[index])'), true);
    await writeFile(path.join(root, 'option.html'), '<html><body>After sketch</body></html>');
    data.title = 'After'; data.questions[0].options[0].sketch = 'option.html?version=2'; await save();
    await page.evaluate('loadFiles()');
    assert.equal(await page.evaluate('currentSession.title'), 'After', 'The disk session itself refreshed');
    await until(async () => (await page.frameValues('document.body.textContent')).filter(text => text === 'After sketch').length === 2, 'disk preview and dialog show After sketch');
    assert.deepEqual(await page.frameValues('document.body.textContent'), ['After sketch', 'After sketch']);
    await writeFile(path.join(root, 'main.html'), '<html><body>Main version 1</body></html>');
    data.sketches = [{ id: 'k1', src: 'main.html', rev: 1 }]; await save(); await page.evaluate('loadFiles()');
    await until(async () => (await page.frameValues('document.body.textContent')).includes('Main version 1'), 'initial main sketch');
    await writeFile(path.join(root, 'main.html'), '<html><body>Main version 2</body></html>');
    data.sketches[0].rev = 2; await save(); await page.evaluate('loadFiles()');
    await until(async () => (await page.frameValues('document.body.textContent')).includes('Main version 2'), 'main sketch revision');
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
