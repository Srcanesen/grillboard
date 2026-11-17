import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserTest as test, stop, until } from './headless-board.mjs';
import { withSessionServer } from './session-server.mjs';

const skill = fileURLToPath(new URL('../../skills/grillboard/', import.meta.url));
test('a reused port isolates session geometry while flows share sizes and keep separate positions', async () => {
  await withSessionServer(async ({ root, child, url, page, data }) => {
    await page.evaluate(`manualOffsets.q1 = { dx: 1234, dy: 456 }; nodeSizes.q1 = 650;
      panelWidth = 470; localStorage.setItem(panelWidthKey, String(panelWidth)); saveOffsets(); saveNodeSizes();`);
    const other = path.join(root, 'other'); await mkdir(other);
    await copyFile(path.join(skill, 'viewer.html'), path.join(other, 'index.html'));
    await writeFile(path.join(other, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({ ...data, title: 'Session B' }) + ';');
    await stop(child);
    let replacement;
    async function start(dir) {
      replacement = spawn('python3', [path.join(skill, 'server.py'), dir, '--serve', '--port', new URL(url).port]);
      let output = ''; replacement.stdout.on('data', bytes => output += bytes);
      await until(() => output.includes('\n'), 'replacement server');
      await page.go(url);
      await until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession?.title === ${JSON.stringify(dir === root ? 'Session A' : 'Session B')} && canWrite`), 'fresh session');
    }
    try {
      await start(other);
      assert.deepEqual(await page.evaluate('({ offset: manualOffsets.q1 || null, width: nodeSizes.q1 || null, panelWidth })'),
        { offset: null, width: null, panelWidth: null });
      await stop(replacement); await start(root);
      assert.deepEqual(await page.evaluate('({ offset: manualOffsets.q1, width: nodeSizes.q1, panelWidth })'),
        { offset: { dx: 1234, dy: 456 }, width: 650, panelWidth: 470 });
      await page.evaluate('toggleFlow()');
      assert.deepEqual(await page.evaluate('({ offset: manualOffsets.q1 || null, width: nodeSizes.q1 || null })'),
        { offset: null, width: 650 });
      await page.evaluate(`nodeSizes.q1 = 500; applyNodeSize(nodeRecords.get('q1')); manualOffsets.q1 = { dx: 10, dy: 20 }; saveNodeSizes(); saveOffsets(); toggleFlow();`);
      const geometry = "({ offset: manualOffsets.q1, width: nodeSizes.q1, renderedWidth: nodeRecords.get('q1').width })";
      assert.deepEqual(await page.evaluate(geometry),
        { offset: { dx: 1234, dy: 456 }, width: 500, renderedWidth: 500 });
      const previousLoad = await page.evaluate('performance.timeOrigin');
      await page.go(url);
      await until(() => page.evaluate(`performance.timeOrigin !== ${previousLoad} && typeof currentSession !== 'undefined' && currentSession?.title === 'Session A'`), 'saved shared size');
      assert.deepEqual(await page.evaluate(geometry),
        { offset: { dx: 1234, dy: 456 }, width: 500, renderedWidth: 500 });
      await page.evaluate('toggleFlow()');
      assert.deepEqual(await page.evaluate(geometry),
        { offset: { dx: 10, dy: 20 }, width: 500, renderedWidth: 500 });
    } finally { if (replacement) await stop(replacement); }
  });
});

test('old unkeyed geometry is ignored without migration', async () => {
  await withSessionServer(async ({ url, page }) => {
    await page.evaluate(`localStorage.clear();
      const old = location.pathname + sessionUrl;
      localStorage.setItem('grill-board:' + old, JSON.stringify({ q1: { dx: 1234, dy: 456 } }));
      localStorage.setItem('grill-node-sizes:' + old, JSON.stringify({ q1: 650 }));
      localStorage.setItem('grill-panel-width:' + old, '470');`);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && !!currentSession"), 'reload');
    assert.deepEqual(await page.evaluate('({ offset: manualOffsets.q1 || null, width: nodeSizes.q1 || null, panelWidth })'),
      { offset: null, width: null, panelWidth: null });
  });
});
