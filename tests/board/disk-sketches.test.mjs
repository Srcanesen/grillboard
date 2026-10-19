import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserTest as test, stop, until } from './headless-board.mjs';
import { inputBrowser } from './input-board.mjs';

test('disk option sketches and their open dialog refresh after a session update', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-disk-sketch-'));
  const children = [];
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    const data = { title: 'Before', questions: [{ id: 'q1', title: 'Storage?', status: 'asking',
      options: [{ id: 'a', label: 'Files', sketch: 'option.html' }] }] };
    const save = () => writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify(data) + ';\n');
    await writeFile(path.join(root, 'option.html'), '<html><body>Before sketch</body></html>');
    await save();
    const page = await inputBrowser(path.join(root, 'chrome-profile'), children);
    await page.go(pathToFileURL(path.join(root, 'index.html')).href);
    await until(() => page.evaluate('typeof currentSession !== "undefined" && !!currentSession'), 'disk render');
    await page.evaluate('document.querySelector(".variant-open").focus(); document.querySelector(".variant-open").click()');
    await until(async () => (await page.frameValues('document.body.textContent')).filter(text => text === 'Before sketch').length === 2, 'two initial sketches');
    await writeFile(path.join(root, 'option.html'), '<html><body>After sketch</body></html>');
    data.title = 'After'; await save();
    await page.evaluate('loadFiles()');
    assert.equal(await page.evaluate('currentSession.title'), 'After', 'The disk session itself refreshed');
    await until(async () => (await page.frameValues('document.body.textContent')).filter(text => text === 'After sketch').length === 2, 'disk preview and dialog show After sketch');
    assert.deepEqual(await page.frameValues('document.body.textContent'), ['After sketch', 'After sketch']);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
