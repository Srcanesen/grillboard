import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserTest as test, serve, stop, until } from './headless-board.mjs';
import { inputBrowser } from './input-board.mjs';

async function withDialog(protocol, check, sketchHtml = '<html><body><button style="position:fixed;inset:0;width:100%;height:100%">Sketch button</button></body></html>') {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-dialog-'));
  const children = [];
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    await writeFile(path.join(root, 'sketch.html'), sketchHtml);
    await writeFile(path.join(root, 'report.md'), '# Storage\n\nReport body.');
    await writeFile(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    await writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
      sketches: [{ id: 'k1', title: 'Storage', src: 'sketch.html', width: 400, height: 300 }],
      research: [{ id: 's1', topic: 'Storage', status: 'done', report: 'report.md' }]
    }) + ';\n');
    const url = protocol === 'file' ? pathToFileURL(path.join(root, 'index.html')).href : await serve(root, children);
    const page = await inputBrowser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate('typeof currentSession !== "undefined" && !!currentSession'), 'board render');
    await page.evaluate(`document.querySelector('.sketch-card').focus(); openEnlargedSketch('k1');`);
    await until(async () => (await page.frameValues('document.body.textContent')).filter(text => text === 'Sketch button').length === 2, 'sandbox sketches');
    await until(async () => {
      await page.click('#lightbox iframe');
      return (await page.frameValues('document.hasFocus() && ["BUTTON", "INPUT"].includes(document.activeElement.tagName)')).some(Boolean);
    }, 'sketch received focus from the click');
    // Let any queued focus handoff complete before sending the user's next key.
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 50))');
    await check(page);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}

for (const protocol of ['http', 'file']) {
  test(protocol + ' sketch retains all five typed characters without running scripts', async () => {
    await withDialog(protocol, async page => {
      for (const character of 'hello') await page.type(character);
      assert.deepEqual((await page.frameValues('document.querySelector("input")?.value')).sort(), ['', 'hello']);
      assert.deepEqual(await page.frameValues('window.sketchScriptRan === true'), [false, false], 'Sketch scripts remain disabled');
      assert.equal(await page.evaluate('document.activeElement === enlargedSketch.surface'), true);
    }, '<html><head><script>window.sketchScriptRan = true;</script></head><body>Sketch button<input style="position:fixed;inset:0;width:100%;height:100%"></body></html>');
  });
  for (const key of [' ', 'Enter']) test(protocol + ' sketch keeps focus and stays open after ' + (key === ' ' ? 'Space' : key), async () => {
    await withDialog(protocol, async page => {
      await page.key(key);
      assert.equal(await page.evaluate('lightbox.hidden'), false);
      assert.equal(await page.evaluate('document.activeElement === enlargedSketch.surface'), true);
    });
  });
  test(protocol + ' sketch supports keyboard scrolling', async () => {
    await withDialog(protocol, async page => {
      await page.key('PageDown');
      await until(async () => (await page.frameValues('scrollY')).some(y => y > 0), 'sketch scrolls down');
      assert.equal(await page.evaluate('document.activeElement === enlargedSketch.surface'), true);
    }, '<html><body style="margin:0;min-height:2000px"><button style="position:fixed;inset:0;width:100%;height:100%">Sketch button</button></body></html>');
  });
  test(protocol + ' sketch Escape ' + (protocol === 'http' ? 'closes and restores its opener' : 'keeps focus in the opaque sketch'), async () => {
    await withDialog(protocol, async page => {
      await page.key('Escape');
      if (protocol === 'http') {
        await until(() => page.evaluate('lightbox.hidden'), 'Escape closes sketch dialog');
        assert.equal(await page.evaluate('document.activeElement === document.querySelector(".sketch-card")'), true);
      } else {
        assert.equal(await page.evaluate('lightbox.hidden'), false);
        assert.equal(await page.evaluate('document.activeElement === enlargedSketch.surface'), true);
      }
    });
  });
  if (protocol === 'http') for (const shift of [false, true]) test(protocol + ' sketch ' + (shift ? 'Shift+Tab' : 'Tab') + ' stays in its dialog from inside the frame', async () => {
    await withDialog(protocol, async page => {
      for (let step = 0; step < 6; step++) {
        await page.key('Tab', shift);
        await until(() => page.evaluate('lightbox.contains(document.activeElement)'), 'Tab focus returns to dialog');
        assert.equal(await page.evaluate('lightbox.contains(document.activeElement)'), true, 'Dialog retains focus on step ' + step);
      }
    });
  });
  if (protocol === 'file') test('file sketch Tab retains native navigation between its inputs', async () => {
    await withDialog(protocol, async page => {
      await page.key('Tab');
      assert.equal((await page.frameValues('document.activeElement.id')).filter(id => id === 'second').length, 1);
      assert.equal(await page.evaluate('document.activeElement === enlargedSketch.surface'), true);
      await page.key('Tab', true);
      assert.equal((await page.frameValues('document.activeElement.id')).filter(id => id === 'first').length, 1);
    }, '<html><body>Sketch button<input id="first" style="position:fixed;inset:0;width:100%;height:100%"><input id="second" style="position:absolute;top:220px"></body></html>');
  });
  test(protocol + ' report and image dialogs retain their keyboard controls and opener focus', async () => {
    await withDialog(protocol, async page => {
      await page.evaluate('closeLightbox(); document.querySelector(".report-card").focus()');
      await page.key('Enter');
      await until(() => page.evaluate('!reader.hidden'), 'report opens');
      for (let step = 0; step < 4; step++) {
        await page.key('Tab', step % 2 === 0);
        assert.equal(await page.evaluate('reader.contains(document.activeElement)'), true);
      }
      await page.key('Escape');
      assert.equal(await page.evaluate('reader.hidden && document.activeElement === document.querySelector(".report-card")'), true);
      await page.evaluate('document.querySelector(".sketch-card").focus(); openLightbox({src:"image.svg", caption:"Storage image"})');
      await page.key('Tab');
      assert.equal(await page.evaluate('lightbox.contains(document.activeElement)'), true);
      await page.key('Escape');
      assert.equal(await page.evaluate('lightbox.hidden && document.activeElement === document.querySelector(".sketch-card")'), true);
    });
  });
}
