import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==', 'base64');

async function user(root) {
  const code = await readFile(path.join(root, 'user.js'), 'utf8');
  return new Function('window', code + '; return window.__GRILL_USER__;')({});
}

async function transfer(page, kind, source, label = 'source') {
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    if (${JSON.stringify(source)} === 'picture') transfer.items.add(new File([Uint8Array.from(${JSON.stringify([...picture])})], ${JSON.stringify(label + '.png')}, {type: 'image/png'}));
    else transfer.setData('text/plain', location.origin + ${JSON.stringify('/' + label)});
    document.activeElement?.blur();
    window.dispatchEvent(${JSON.stringify(kind)} === 'paste'
      ? new ClipboardEvent('paste', {clipboardData: transfer, cancelable: true})
      : new DragEvent('drop', {dataTransfer: transfer, clientX: 5, clientY: 400, cancelable: true}));
  })()`);
}

for (const kind of ['paste', 'drop']) for (const source of ['url', 'picture']) test('a failed ' + kind + ' keeps its ' + source + ' and retries without transferring it again', async () => {
  await withBoard({ lang: 'en' }, async ({ root, url, page }) => {
    await page.evaluate(`window.originalFetch = fetch; window.addAttempts = 0;
      window.fetch = (input, options) => {
        if (options?.method === 'POST' && new URL(input).pathname === '/api/refs') {
          addAttempts++;
          return originalFetch(new URL('api/refs/missing', location.href), options);
        }
        return originalFetch(input, options);
      };`);
    await transfer(page, kind, source);
    await until(() => page.evaluate('addAttempts === 1'), 'failed add request');
    await until(() => page.evaluate('!!document.querySelector(".retry-reference") || !toastNode.hidden'), 'addition error');
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")?.textContent'), 'Retry');
    assert.equal((await user(root)).refs.length, 0);
    // Unrelated renders and another failure must preserve the same source and retry control.
    await page.evaluate('loadFiles(); document.querySelector(".retry-reference").click()');
    await until(() => page.evaluate('addAttempts === 2 && !document.querySelector(".retry-reference").disabled'), 'second failed attempt');
    assert.equal(await page.evaluate('document.querySelectorAll(".retry-reference").length'), 1);
    await page.evaluate('window.fetch = originalFetch; document.querySelector(".retry-reference").click()');
    await until(() => page.evaluate('currentUserRefs.length === 1'), 'retried reference appears');
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")'), null);
    const refs = (await user(root)).refs;
    assert.equal(refs.length, 1);
    if (source === 'url') assert.equal(refs[0].src, url + 'source');
    else {
      assert.equal(refs[0].name, 'source.png');
      assert.deepEqual(await readFile(path.join(root, refs[0].src)), picture);
    }
    if (kind === 'drop') assert.equal(await page.evaluate('!!manualOffsets[currentUserRefs[0].nodeId]'), true, 'Retry retains the drop position');
  });
});

test('read-only transfers retain every source until retry or dismissal', async () => {
  await withBoard({ lang: 'en' }, async ({ root, url, page }) => {
    await page.evaluate('stopSession()');
    await transfer(page, 'paste', 'url', 'first');
    await transfer(page, 'drop', 'picture', 'second');
    assert.equal(await page.evaluate('document.querySelectorAll(".retry-reference").length'), 2);
    assert.equal((await user(root)).refs.length, 0);
    await page.evaluate('document.querySelectorAll(".dismiss-reference")[1].click(); detectServer()');
    await until(() => page.evaluate('canWrite'), 'writable board returns');
    await page.evaluate('document.querySelector(".retry-reference").click()');
    await until(() => page.evaluate('currentUserRefs.length === 1'), 'remaining source saves');
    assert.equal((await user(root)).refs[0].src, url + 'first');
    assert.equal(await page.evaluate('document.querySelectorAll(".retry-reference").length'), 0);
  });
});
