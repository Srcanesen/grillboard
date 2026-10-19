import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, withBoard } from './headless-board.mjs';

const data = { lang: 'en', title: 'Reopened question', questions: [{
  id: 'q1', title: 'Storage?', status: 'asking', options: [{ id: 'a', label: 'Files' }]
}] };

test('polling a saved response retires its request id before the same answer is sent again', async () => {
  await withBoard(data, async ({ root, page, session }) => {
    await page.evaluate(`(async () => {
      const originalFetch = fetch;
      let lost = false;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!lost && new URL(args[0]).pathname === '/api/answers') {
          lost = true; await response.text(); throw new TypeError('Lost saved response');
        }
        return response;
      };
      document.querySelector('[data-answer-option=a]').click();
      await sendRoundAnswers();
      await loadFiles();
    })()`);
    assert.equal(await page.evaluate('latestUser.answers[0].id'), 'a1');
    assert.equal(await page.evaluate('answerError'), 'Could not send answers. Try again.');
    await session({ ...data, answered: 'a1' });
    await page.evaluate('sendRoundAnswers()');
    const text = await readFile(path.join(root, 'user.js'), 'utf8');
    const stored = JSON.parse(text.slice('window.__GRILL_USER__ = '.length).trim().slice(0, -1));
    const batches = stored.answers;
    assert.deepEqual(batches.map(batch => batch.id), ['a1', 'a2']);
    assert.deepEqual(batches.map(batch => batch.items), [
      [{ question: 'q1', option: 'a', text: '' }], [{ question: 'q1', option: 'a', text: '' }]
    ]);
    assert.deepEqual(Object.values(stored.answerRequests).sort(), ['a1', 'a2']);
  });
});
