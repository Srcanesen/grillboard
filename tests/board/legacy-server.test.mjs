import assert from 'node:assert/strict';
import { browserTest as test } from './headless-board.mjs';
import { withSessionServer } from './session-server.mjs';

test('a board first opened on a legacy server can still save an answer', async () => {
  await withSessionServer(async ({ page }) => {
    assert.equal(await page.evaluate('canWrite'), true);
    assert.equal(await page.evaluate('roundBar.hidden'), false);
    await page.evaluate(`document.querySelector('[data-answer-option=a]').click(); sendRoundAnswers()`);
    assert.deepEqual(await page.evaluate('latestUser.answers[0].items'), [{ question: 'q1', option: 'a', text: '' }]);
  }, 'legacy');
});

test('a modern session never falls back to an unidentified server', async () => {
  await withSessionServer(async ({ page, ping }) => {
    await ping('legacy');
    await page.evaluate('loadFiles(false)');
    assert.equal(await page.evaluate('canWrite'), false);
    assert.equal(await page.evaluate('apiRequest("api/answers", "POST", { items: [{ question: "q1", option: "a", text: "" }] }).then(() => true, () => false)'), false);
    await ping('normal');
    await page.evaluate('loadFiles(false)');
    assert.equal(await page.evaluate('canWrite && !roundBar.hidden'), true);
  });
});

test('a legacy board does not adopt a different kind of server identity', async () => {
  await withSessionServer(async ({ page, ping }) => {
    await ping('normal');
    await page.evaluate('loadFiles(false)');
    assert.equal(await page.evaluate('canWrite'), false);
    assert.equal(await page.evaluate('currentSession.title'), 'Session A');
  }, 'legacy');
});
