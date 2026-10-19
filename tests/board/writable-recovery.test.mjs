import assert from 'node:assert/strict';
import { browserTest as test, stop, until } from './headless-board.mjs';
import { withSessionServer } from './session-server.mjs';

const writable = `canWrite && !roundBar.hidden && !document.querySelector('.read-only-notice') &&
  document.querySelector('.answer-editor')?.readOnly === false`;

test('one failed ping during a file change keeps the board writable', async () => {
  await withSessionServer(async ({ page, save, data }) => {
    await save({ ...data, title: 'Updated session A' });
    await page.evaluate(`window.originalFetch = fetch; window.pings = 0;
      window.fetch = (...args) => {
        if (String(args[0]).endsWith('/api/ping') && ++pings >= 2) return Promise.reject(new TypeError('Connection closed'));
        return originalFetch(...args);
      };`);
    await page.evaluate('loadFiles(false)');
    assert.equal(await page.evaluate('currentSession.title'), 'Updated session A');
    assert.equal(await page.evaluate('canWrite'), true);
    await page.evaluate('window.fetch = originalFetch; loadFiles(false)');
    assert.equal(await page.evaluate(writable), true, 'A matching ping must preserve controls without another file change');
    await page.evaluate(`document.querySelector('[data-answer-option=a]').click(); sendRoundAnswers()`);
    assert.deepEqual(await page.evaluate('latestUser.answers[0].items'), [{ question: 'q1', option: 'a', text: '' }]);
  });
});

test('the own server restarting on its port keeps writable controls without reload', async () => {
  await withSessionServer(async ({ page, save, data, child, start, url }) => {
    await save({ ...data, title: 'Updated session A' });
    await page.evaluate(`window.originalFetch = fetch; window.pings = 0; window.releasePing = null;
      window.fetch = async (...args) => {
        if (String(args[0]).endsWith('/api/ping') && ++pings === 2) await new Promise(resolve => { releasePing = resolve; });
        return originalFetch(...args);
      };
      window.pollResult = loadFiles(false); void 0;`);
    await until(() => page.evaluate('!!releasePing'), 'second ping after changed file read');
    await stop(child);
    await page.evaluate('(async () => { releasePing(); await pollResult; })()');
    assert.equal(await page.evaluate('canWrite'), true);
    assert.equal((await start(new URL(url).port)).url, url);
    await until(() => page.evaluate(writable), 'own server restores writable controls');
  });
});

test('an invalid ping preserves state but a different session disables writes', async () => {
  await withSessionServer(async ({ page }) => {
    await page.evaluate(`window.originalFetch = fetch;
      window.fetch = (...args) => String(args[0]).endsWith('/api/ping')
        ? Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 503 })) : originalFetch(...args);`);
    await page.evaluate('loadFiles(false)');
    assert.equal(await page.evaluate('canWrite'), true);
    await page.evaluate('window.fetch = originalFetch; loadFiles(false)');
    assert.equal(await page.evaluate(writable), true, 'The original identity must keep controls writable');
    await page.evaluate(`window.fetch = (...args) => String(args[0]).endsWith('/api/ping')
      ? Promise.resolve(new Response(JSON.stringify({ ok: true, board: 1, session: '/other-session' }))) : originalFetch(...args);
      loadFiles(false);`);
    assert.equal(await page.evaluate('canWrite'), false);
    assert.equal(await page.evaluate('apiRequest("api/answers", "POST", { items: [{ question: "q1", option: "a", text: "" }] }).then(() => true, () => false)'), false);
    await page.evaluate(`window.fetch = () => Promise.reject(new TypeError('Connection closed')); loadFiles(false);`);
    assert.equal(await page.evaluate('canWrite'), false, 'A failed ping must also preserve a verified read-only state');
    await page.evaluate('window.fetch = originalFetch; loadFiles(false)');
    assert.equal(await page.evaluate(writable), true);
  });
});
