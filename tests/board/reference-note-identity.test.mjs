import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const sessionData = { lang: 'en', questions: [{ id: 'q1', title: 'Pictures', status: 'asking', options: [
  { id: 'a', label: 'First picture' }, { id: 'b', label: 'Second picture' }
] }] };
const picture = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==', 'base64')];

async function pictures(page, secondTarget) {
  await page.evaluate(`(async () => {
    window.pictureRefs = [];
    for (const target of ['q1:a', ${JSON.stringify(secondTarget)}]) {
      const result = await apiRequest('api/refs?' + new URLSearchParams({target, name: 'picture.png'}), 'POST', Uint8Array.from(${JSON.stringify(picture)}), 'image/png');
      pictureRefs.push(result.ref.id);
    }
    await loadFiles();
    const note = document.querySelector(${JSON.stringify(secondTarget ? '[data-answer-option=b] button.ref-note' : '.reference-card button.ref-note')});
    note.click(); document.querySelector('.note-editor').select();
    window.noteEditor = document.querySelector('.note-editor');
    window.originalFetch = fetch; window.noteRequests = 0;
    window.fetch = (input, options) => {
      if (options?.method === 'POST' && options.body?.includes('"note":')) noteRequests++;
      return originalFetch(input, options);
    };
  })()`);
  await page.type('Keep the second note');
  await page.evaluate('noteEditor.setSelectionRange(5, 12)');
}

async function assertDraft(page, option) {
  assert.deepEqual(await page.evaluate(`({ text: document.querySelector('.note-editor')?.value,
    same: document.querySelector('.note-editor') === noteEditor, focused: document.activeElement === noteEditor,
    selection: [noteEditor.selectionStart, noteEditor.selectionEnd],
    option: noteEditor.closest('.option')?.querySelector('.option-label')?.textContent ?? null,
    requests: noteRequests })`),
  { text: 'Keep the second note', same: true, focused: true, selection: [5, 12], option, requests: 0 });
}

async function saveSecond(root, page) {
  await page.key('Enter');
  await until(() => page.evaluate('!document.querySelector(".note-editor")'), 'note saves');
  const code = await readFile(path.join(root, 'user.js'), 'utf8');
  const refs = new Function('window', code + '; return window.__GRILL_USER__.refs;')({});
  assert.deepEqual(refs.map(ref => ref.note), ['', 'Keep the second note']);
}

test('a rebuilt question restores the note under its own option picture, not the first picture', async () => {
  await withBoard(sessionData, async ({ root, page, session }) => {
    await pictures(page, 'q1:b');
    await session({ ...sessionData, questions: [{ ...sessionData.questions[0], body: 'Updated question' }] });
    await assertDraft(page, 'Second picture');
    assert.equal(await page.evaluate('!!document.querySelector("[data-answer-option=a] button.ref-note")'), true);
    await saveSecond(root, page);
  });
});

for (const direction of ['standalone to option', 'option to standalone']) test('the open note follows its reference from ' + direction, async () => {
  await withBoard(sessionData, async ({ root, page }) => {
    await pictures(page, direction === 'standalone to option' ? '' : 'q1:b');
    await page.evaluate(`(async () => {
      await apiRequest('api/refs/' + pictureRefs[1], 'POST', {target: ${JSON.stringify(direction === 'standalone to option' ? 'q1:b' : '')}});
      await loadFiles();
    })()`);
    await assertDraft(page, direction === 'standalone to option' ? 'Second picture' : null);
    if (direction === 'option to standalone') assert.equal(await page.evaluate('noteEditor.closest(".reference-card")?.dataset.refId'), await page.evaluate('pictureRefs[1]'));
    await saveSecond(root, page);
  });
});

test('a reference no longer drawn keeps a visible draft across later renders and failed saves until explicitly cancelled', async () => {
  await withBoard(sessionData, async ({ page, session }) => {
    await pictures(page, 'q1:b');
    await page.evaluate(`(async () => { await apiRequest('api/refs/' + pictureRefs[1], 'DELETE'); await loadFiles(); })()`);
    await assertDraft(page, null);
    assert.equal(await page.evaluate('document.querySelector(".reference-note-draft")?.textContent.includes("Your note is kept here.")'), true);
    assert.equal(await page.evaluate('document.querySelector(".note-editor").getClientRects().length > 0'), true);
    await session({ ...sessionData, title: 'Another agent update' });
    await assertDraft(page, null);
    await page.key('Enter');
    await until(() => page.evaluate('!toastNode.hidden'), 'missing reference save fails');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")?.value'), 'Keep the second note');
    await page.key('Escape');
    assert.equal(await page.evaluate('document.querySelector(".note-editor")'), null);
    assert.equal(await page.evaluate('document.querySelector(".reference-note-draft")'), null);
  });
});

test('a note hidden by a settled question stays visible and returns to its picture when shown again', async () => {
  await withBoard(sessionData, async ({ root, page, session }) => {
    await pictures(page, 'q1:b');
    await session({ ...sessionData, questions: [{ ...sessionData.questions[0], status: 'settled', answer: { option: 'a', text: '' } }] });
    await assertDraft(page, null);
    assert.equal(await page.evaluate('document.querySelector(".note-editor").getClientRects().length > 0'), true);
    await session(sessionData);
    await assertDraft(page, 'Second picture');
    assert.equal(await page.evaluate('document.querySelector(".reference-note-draft")'), null);
    await saveSecond(root, page);
  });
});
