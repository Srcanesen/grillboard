import assert from 'node:assert/strict';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const data = { lang: 'en', questions: [{ id: 'q1', title: 'Storage?', status: 'asking',
  options: [{ id: 'a', label: 'Files' }] }] };

test('polling a committed answer unlocks the next round while its HTTP response is stalled', async () => {
  await withBoard(data, async ({ page, session }) => {
    await page.evaluate(`window.originalFetch = fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (new URL(args[0]).pathname === '/api/answers') {
          await response.text();
          return new Promise(resolve => { window.releaseAnswer = () => resolve(new Response(JSON.stringify({ ok: true, batch: { id: 'a1' } }))); });
        }
        return response;
      };
      document.querySelector('[data-answer-option=a]').click(); void sendRoundAnswers();`);
    await until(() => page.evaluate('currentSession.pendingCount === 1'), 'poll discovers committed answer');
    await session({ ...data, answered: 'a1', questions: [
      { ...data.questions[0], status: 'settled', answer: { option: 'a' }, decision: 'Files' },
      { id: 'q2', title: 'Next question', status: 'asking' }
    ] });
    await page.evaluate(`const editor = document.querySelector('.answer-editor'); editor.value = 'Next answer'; editor.dispatchEvent(new Event('input'));`);
    assert.deepEqual(await page.evaluate(`({ sending: sendingAnswers, readOnly: document.querySelector('.answer-editor').readOnly,
      sendDisabled: document.querySelector('.send-answers').disabled })`),
    { sending: false, readOnly: false, sendDisabled: false });
    await page.evaluate(`window.releaseAnswer(); new Promise(resolve => setTimeout(resolve, 50))`);
    assert.equal(await page.evaluate('answerError'), '');
    assert.equal(await page.evaluate("document.querySelector('.answer-editor').readOnly"), false);
  });
});

test('a write deadline unlocks a failed answer and retains its request id for retry', async () => {
  await withBoard(data, async ({ page }) => {
    await page.evaluate(`window.originalFetch = fetch; window.originalSetTimeout = setTimeout;
      window.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 100 : delay, ...args);
      window.fetch = (...args) => new URL(args[0]).pathname === '/api/answers'
        ? new Promise((resolve, reject) => args[1].signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError'))))
        : originalFetch(...args);
      document.querySelector('[data-answer-option=a]').click(); void sendRoundAnswers();
      window.failedRequestId = answerRequest.requestId;`);
    await until(() => page.evaluate('!sendingAnswers && !!answerError'), 'write deadline');
    assert.equal(await page.evaluate('answerRequest.requestId === failedRequestId'), true);
    assert.equal(await page.evaluate("document.querySelector('.send-answers').disabled"), false);
    await page.evaluate('window.fetch = originalFetch; window.setTimeout = originalSetTimeout; sendRoundAnswers()');
    assert.equal(await page.evaluate('latestUser.answerRequests[failedRequestId]'), 'a1');
  });
});
