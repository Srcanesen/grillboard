import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const savedUser = await readFile(path.join(root, 'user.js'), 'utf8');
    // Invalid persisted data makes the real server return 500 for each add attempt.
    await writeFile(path.join(root, 'user.js'), 'window.__GRILL_USER__ = {"version":0};\n');
    await page.evaluate(`window.originalFetch = fetch; window.addAttempts = 0;
      window.fetch = (input, options) => {
        if (options?.method === 'POST' && new URL(input).pathname === '/api/refs') {
          addAttempts++;
          return originalFetch(input, options);
        }
        return originalFetch(input, options);
      };`);
    await transfer(page, kind, source);
    await until(() => page.evaluate('addAttempts === 1'), 'failed add request');
    await until(() => page.evaluate('!!document.querySelector(".retry-reference") || !toastNode.hidden'), 'addition error');
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")?.textContent'), 'Retry');
    assert.equal(await page.evaluate('document.querySelector(".reference-add-reason")?.textContent'), 'Could not read or save session');
    assert.equal(await page.evaluate('currentUserRefs.length'), 0);
    // Unrelated renders and another failure must preserve the same source and retry control.
    await page.evaluate('loadFiles(); document.querySelector(".retry-reference").click()');
    await until(() => page.evaluate('addAttempts === 2 && !document.querySelector(".retry-reference").disabled'), 'second failed attempt');
    assert.equal(await page.evaluate('document.querySelectorAll(".retry-reference").length'), 1);
    await writeFile(path.join(root, 'user.js'), savedUser);
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

test('read-only transfers show the reason and Dismiss without an unusable Retry', async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await page.evaluate('stopSession()');
    await transfer(page, 'paste', 'url', 'first');
    await transfer(page, 'drop', 'picture', 'second');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".reference-add-reason")].map(node => node.textContent)'),
      ['Adding references needs the board server.', 'Adding references needs the board server.']);
    assert.equal(await page.evaluate('document.querySelectorAll(".retry-reference").length'), 0);
    assert.equal((await user(root)).refs.length, 0);
    await page.evaluate('document.querySelectorAll(".dismiss-reference")[1].click()');
    assert.equal(await page.evaluate('document.querySelectorAll(".reference-add-error").length'), 1);
    assert.equal(await page.evaluate('document.querySelector(".reference-add-error").textContent.includes("first")'), true);
  });
});

test('a board opened from disk explains that adding a reference needs a server', async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await page.go(pathToFileURL(path.join(root, 'index.html')).href);
    await until(() => page.evaluate('typeof currentSession !== "undefined" && !!currentSession'), 'disk board render');
    await page.evaluate(`const transfer = new DataTransfer(); transfer.setData('text/plain', 'https://example.com/source');
      window.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, cancelable: true}));`);
    await until(() => page.evaluate('!!document.querySelector(".reference-add-error")'), 'disk transfer failure');
    assert.equal(await page.evaluate('document.querySelector(".reference-add-reason")?.textContent'), 'Adding references needs the board server.');
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")'), null);
    await page.evaluate('document.querySelector(".dismiss-reference").click()');
    assert.equal(await page.evaluate('document.querySelector(".reference-add-error")'), null);
  });
});

for (const rejected of ['large picture', 'long URL', 'unsupported picture']) test('a rejected ' + rejected + ' shows its reason with Dismiss only', async () => {
  await withBoard({ lang: 'en' }, async ({ page }) => {
    await page.evaluate(`window.originalFetch = fetch; window.addStatuses = [];
      window.fetch = async (input, options) => {
        const response = await originalFetch(input, options);
        if (options?.method === 'POST') addStatuses.push(response.status);
        return response;
      };
      const transfer = new DataTransfer();
      if (${JSON.stringify(rejected)} === 'long URL') transfer.setData('text/plain', location.origin + '/' + 'x'.repeat(2100));
      else transfer.items.add(${JSON.stringify(rejected)} === 'large picture'
        ? new File([new Uint8Array(15 * 1024 * 1024 + 1)], 'large.png', {type: 'image/png'})
        : new File(['picture'], 'vector.svg', {type: 'image/svg+xml'}));
      window.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, clientX: 5, clientY: 400, cancelable: true}));`);
    await until(() => page.evaluate('!!document.querySelector(".reference-add-error") || !toastNode.hidden'), 'rejection is shown');
    assert.deepEqual(await page.evaluate('addStatuses'), rejected === 'unsupported picture' ? [] : [rejected === 'large picture' ? 413 : 400]);
    assert.equal(await page.evaluate('document.querySelector(".reference-add-reason")?.textContent'),
      rejected === 'large picture' ? 'This picture is too large. Use a smaller picture.' : rejected === 'long URL' ? 'Bad URL' : 'Only PNG, JPEG, GIF and WebP pictures can be added.');
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")'), null);
    await page.evaluate('document.querySelector(".dismiss-reference").click()');
    assert.equal(await page.evaluate('document.querySelector(".reference-add-error")'), null);
  });
});

for (const error of ['network', 'timeout']) test('a ' + error + ' error explains the failure and retains a working Retry', async () => {
  await withBoard({ lang: 'en' }, async ({ page, url, root }) => {
    await page.evaluate(`window.originalFetch = fetch;
      window.fetch = (input, options) => options?.method === 'POST'
        ? Promise.reject(${JSON.stringify(error)} === 'network' ? new TypeError('Failed to fetch') : new DOMException('Timed out', 'TimeoutError'))
        : originalFetch(input, options);`);
    await transfer(page, 'paste', 'url');
    await until(() => page.evaluate('!!document.querySelector(".reference-add-error")'), 'transport failure card');
    assert.equal(await page.evaluate('document.querySelector(".reference-add-reason")?.textContent'), 'Could not reach the board server. Try again.');
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")?.textContent'), 'Retry');
    await page.evaluate('window.fetch = originalFetch; document.querySelector(".retry-reference").click()');
    await until(() => page.evaluate('currentUserRefs.length === 1'), 'transport retry succeeds');
    assert.equal((await user(root)).refs[0].src, url + 'source');
    assert.equal(await page.evaluate('document.querySelector(".reference-add-error")'), null);
  });
});

test('a retry that receives a permanent rejection updates the reason and removes Retry', async () => {
  await withBoard({ lang: 'en' }, async ({ page }) => {
    await page.evaluate(`window.originalFetch = fetch;
      window.fetch = (input, options) => options?.method === 'POST'
        ? Promise.reject(new TypeError('Failed to fetch')) : originalFetch(input, options);`);
    await transfer(page, 'paste', 'url');
    await page.evaluate(`window.fetch = (input, options) => options?.method === 'POST'
      ? originalFetch(new URL('api/refs/missing', location.href), options) : originalFetch(input, options);
      document.querySelector('.retry-reference').click();`);
    await until(() => page.evaluate('document.querySelector(".reference-add-reason")?.textContent === "Unknown reference"'), 'updated rejection reason');
    assert.equal(await page.evaluate('document.querySelectorAll(".reference-add-error").length'), 1);
    assert.equal(await page.evaluate('document.querySelector(".retry-reference")'), null);
    assert.equal(await page.evaluate('!!document.querySelector(".dismiss-reference")'), true);
  });
});
