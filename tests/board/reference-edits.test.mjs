import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

async function user(root) {
  const code = await readFile(path.join(root, 'user.js'), 'utf8');
  return new Function('window', code + '; return window.__GRILL_USER__;')({});
}

async function reference(page, note) {
  await page.evaluate(`(async () => {
    const result = await apiRequest('api/refs', 'POST', {url: location.origin + '/source', target: ''});
    window.referenceId = result.ref.id;
    if (${JSON.stringify(note)}) await apiRequest('api/refs/' + referenceId, 'POST', {note: ${JSON.stringify(note)}});
    await loadFiles();
    document.querySelector('.reference-card button.ref-note').click();
    document.querySelector('.note-editor').select();
  })()`);
}

for (const original of ['', 'Existing note']) test('a failed ' + (original ? 'edited' : 'new') + ' reference note stays open through a pending request and retry', async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await reference(page, original);
    await page.type('Keep this note');
    await page.evaluate(`window.originalFetch = fetch; window.noteRequests = 0;
      window.fetch = (input, options) => {
        if (options?.method === 'POST' && new URL(input).pathname === '/api/refs/' + referenceId) {
          noteRequests++;
          return new Promise(resolve => { window.releaseNote = () => resolve(originalFetch(new URL('api/refs/missing', location.href), options)); });
        }
        return originalFetch(input, options);
      };`);
    await page.key('Enter');
    await until(() => page.evaluate('!!window.releaseNote'), 'note request is pending');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")?.value'), 'Keep this note');
    await page.key('Enter');
    await page.evaluate('document.querySelector("#spec-toggle").focus()');
    assert.equal(await page.evaluate('noteRequests'), 1, 'Enter and blur cannot duplicate an in-flight save');
    await page.evaluate('releaseNote()');
    await until(() => page.evaluate('!toastNode.hidden'), 'save error');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")?.value'), 'Keep this note');
    assert.equal(await page.evaluate('toastNode.textContent'), 'Could not save the note. Try again.');
    assert.equal((await user(root)).refs[0].note, original);
    await page.evaluate('window.fetch = originalFetch; document.querySelector(".note-editor").focus()');
    await page.key('Enter');
    await until(() => page.evaluate('!document.querySelector(".note-editor")'), 'confirmed note save closes editor');
    assert.equal((await user(root)).refs[0].note, 'Keep this note');
    await until(() => page.evaluate('document.querySelector(".reference-card button.ref-note")?.textContent === "Keep this note"'), 'saved note is displayed');
  });
});

for (const failure of ['timeout', 'read-only']) test('a ' + failure + ' note save preserves the draft and can be retried', async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await reference(page, 'Existing note'); await page.type('Retry this note');
    if (failure === 'timeout') await page.evaluate(`window.originalFetch = fetch;
      window.fetch = (input, options) => options?.method === 'POST'
        ? Promise.reject(new DOMException('The request timed out', 'TimeoutError')) : originalFetch(input, options);`);
    else await page.evaluate('stopSession()');
    await page.key('Enter');
    await until(() => page.evaluate('!toastNode.hidden'), 'note error is shown');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")?.value'), 'Retry this note');
    assert.equal((await user(root)).refs[0].note, 'Existing note');
    await page.evaluate('(async () => { if (window.originalFetch) window.fetch = originalFetch; await detectServer(); document.querySelector(".note-editor").focus(); })()');
    await page.key('Enter');
    await until(() => page.evaluate('!document.querySelector(".note-editor")'), 'retry saves the note');
    assert.equal((await user(root)).refs[0].note, 'Retry this note');
  });
});

test('clearing a note keeps the empty draft after failure, and Escape cancels without another write', async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await reference(page, 'Existing note');
    await page.evaluate(`document.querySelector('.note-editor').value = ''; window.originalFetch = fetch; window.noteRequests = 0;
      window.fetch = (input, options) => {
        if (options?.method === 'POST') { noteRequests++; return originalFetch(new URL('api/refs/missing', location.href), options); }
        return originalFetch(input, options);
      };`);
    await page.key('Enter'); await until(() => page.evaluate('!toastNode.hidden'), 'clear-note error');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")?.value'), '');
    await page.key('Escape');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")'), null);
    assert.equal(await page.evaluate('noteRequests'), 1);
    assert.equal((await user(root)).refs[0].note, 'Existing note');
  });
});

for (const operation of ['delete', 'disconnect']) test('a failed reference ' + operation + ' keeps its stored note and target', async () => {
  await withBoard({ lang: 'en' }, async ({ root, page }) => {
    await reference(page, 'Keep this note'); await page.key('Escape');
    await page.evaluate(`(async () => {
      await apiRequest('api/refs/' + referenceId, 'POST', {target: 'idea'}); await loadFiles();
      window.originalFetch = fetch;
      window.fetch = (input, options) => ['DELETE', 'POST'].includes(options?.method)
        ? originalFetch(new URL('api/refs/missing', location.href), options) : originalFetch(input, options);
      document.querySelector(${JSON.stringify(operation === 'delete' ? '.delete-ref' : '.disconnect-ref')}).click();
    })()`);
    await until(() => page.evaluate('!toastNode.hidden'), 'reference error');
    assert.equal(await page.evaluate('document.querySelectorAll(".reference-card").length'), 1);
    const refs = (await user(root)).refs;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].note, 'Keep this note');
    assert.equal(refs[0].target, 'idea');
    assert.equal(await page.evaluate('currentUserRefs[0].target'), 'idea');
    await page.evaluate(`window.fetch = originalFetch; document.querySelector(${JSON.stringify(operation === 'delete' ? '.delete-ref' : '.disconnect-ref')}).click()`);
    await until(() => page.evaluate(operation === 'delete' ? 'currentUserRefs.length === 0' : 'currentUserRefs[0].target === ""'), 'reference operation succeeds on retry');
    assert.equal((await user(root)).refs.length, operation === 'delete' ? 0 : 1);
  });
});
