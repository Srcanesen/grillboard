import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, withBoard } from './headless-board.mjs';
import { loadBlock } from './load-block.mjs';

const data = { lang: 'en', questions: [{ id: 'q1', title: 'Storage?', status: 'asking',
  options: [{ id: 'a', label: 'Files' }] }] };

test('an empty pending item leaves the real question editable instead of Sent', async () => {
  await withBoard(data, async ({ root, page }) => {
    await writeFile(path.join(root, 'user.js'), 'window.__GRILL_USER__ = {answers:[{id:"a1",items:[{question:"q1"}]}]};');
    await page.evaluate('loadFiles()');
    assert.deepEqual(await page.evaluate(`({ pending: currentSession.questionsById.q1.pending,
      text: document.querySelector('.answer-editor').value, readOnly: document.querySelector('.answer-editor').readOnly,
      sendExists: !!document.querySelector('.send-answers'), badge: document.querySelector('.pending-badge')?.textContent || '' })`),
    { pending: false, text: '', readOnly: false, sendExists: true, badge: '' });
    const session = loadBlock('grill-session', 'GrillSession');
    const pending = item => session.model(data, { answers: [{ id: 'a1', items: [{ question: 'q1', ...item }] }] }).questions[0];
    assert.equal(pending({ option: 'missing' }).pending, false);
    assert.equal(pending({ text: {} }).pending, false);
    assert.deepEqual(pending({ option: 'a' }).pendingItem, { question: 'q1', option: 'a', text: '' });
    assert.deepEqual(pending({ option: 'missing', text: 'Own answer' }).pendingItem,
      { question: 'q1', option: null, text: 'Own answer' });
  });
});
