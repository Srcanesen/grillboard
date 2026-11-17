import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const picture = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==', 'base64')];

for (const source of ['url', 'picture']) for (const poll of [true, false]) test(`retrying a committed reference keeps one copy ${poll ? 'after polling' : 'during a polling outage'} (${source})`, async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await page.evaluate(`window.originalFetch = fetch; window.refWrites = [];
      window.originalReadScript = readScript;
      ${poll ? '' : "readScript = (...args) => args[1] === '__GRILL_USER__' ? Promise.resolve(latestUser) : originalReadScript(...args);"}
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const address = new URL(args[0]);
        if (args[1]?.method === 'POST' && address.pathname === '/api/refs') {
          refWrites.push(address.searchParams.get('requestId'));
          if (refWrites.length === 1) { await response.text(); throw new TypeError('Response lost after save'); }
        }
        return response;
      };
      const transfer = new DataTransfer();
      if (${JSON.stringify(source)} === 'picture') transfer.items.add(new File([Uint8Array.from(${JSON.stringify(picture)})], 'source.png', { type: 'image/png' }));
      else transfer.setData('text/plain', location.origin + '/source');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true }));`);
    await until(() => page.evaluate('!!document.querySelector(".retry-reference")'), 'reference retry');
    if (poll) await page.evaluate('loadFiles()');
    await page.evaluate('document.querySelector(".retry-reference")?.click()');
    await until(() => page.evaluate('!document.querySelector(".retry-reference")'), 'saved operation reconciled');
    const user = new Function('window', await readFile(path.join(root, 'user.js'), 'utf8') + '; return window.__GRILL_USER__;')({});
    assert.deepEqual(user.refs.map(ref => ref.id), ['u1']);
    const requests = await page.evaluate('refWrites');
    assert.equal(typeof requests[0], 'string');
    assert.deepEqual(user.refRequests, { [requests[0]]: 'u1' });
    if (!poll) assert.equal(requests[1], requests[0]);
  });
});


test('an older server ignoring reference request ids retains its existing retry behavior', async () => {
  await withBoard({ lang: 'en' }, async ({ page }) => {
    await page.evaluate(`window.originalFetch = fetch; window.refWrites = 0;
      window.fetch = async (input, options) => {
        const address = new URL(input);
        if (options?.method === 'POST' && address.pathname === '/api/refs') {
          // Ignore the new parameter, as older servers do.
          address.searchParams.delete('requestId');
          const response = await originalFetch(address, options);
          if (++refWrites === 1) { await response.text(); throw new TypeError('Response lost after save'); }
          return response;
        }
        return originalFetch(input, options);
      };
      const transfer = new DataTransfer(); transfer.setData('text/plain', location.origin + '/source');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true }));`);
    await until(() => page.evaluate('!!document.querySelector(".retry-reference")'), 'legacy reference retry');
    await page.evaluate('loadFiles()');
    assert.deepEqual(await page.evaluate('currentUserRefs.map(ref => ref.id)'), ['u1']);
    assert.equal(await page.evaluate('!!document.querySelector(".retry-reference")'), true);
    await page.evaluate('document.querySelector(".retry-reference").click()');
    await until(() => page.evaluate('currentUserRefs.length === 2'), 'legacy retry response');
    assert.deepEqual(await page.evaluate('currentUserRefs.map(ref => ref.id)'), ['u1', 'u2']);
  });
});
