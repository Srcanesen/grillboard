import assert from 'node:assert/strict';
import { browserTest as test, until } from './headless-board.mjs';
import { withSessionServer } from './session-server.mjs';

for (const mode of ['slow', 'transport error']) {
  test(`a ${mode} second ping preserves the editor, focus and typed answer`, async () => {
    await withSessionServer(async ({ page, ping }) => {
      await page.evaluate('loadFiles(false)');
      await page.click('.answer-editor');
      await page.type('Keep this ');
      await page.evaluate(`window.editorBeforePing = document.activeElement;
        window.cardsBeforePing = [...document.querySelectorAll('.node')];
        window.originalFetch = fetch; window.pings = 0; window.releasePing = null;
        window.fetch = async (...args) => {
          if (String(args[0]).endsWith('/api/ping') && ++pings === 2) {
            await new Promise(resolve => { releasePing = resolve; });
            if (${JSON.stringify(mode)} === 'transport error') throw new TypeError('Connection closed');
          }
          return originalFetch(...args);
        };
        window.pollResult = loadFiles(false); void 0;`);
      await until(() => page.evaluate('!!releasePing'), 'second ping after file reads');
      if (mode === 'slow') await ping('slow');
      await page.evaluate('releasePing(); void 0;');
      await page.type('typing');
      await page.evaluate('pollResult');
      const state = () => page.evaluate(`({ writable: canWrite,
        focused: document.activeElement === editorBeforePing,
        sameEditor: document.querySelector('.answer-editor') === editorBeforePing,
        sameCards: cardsBeforePing.every((card, index) => card === document.querySelectorAll('.node')[index]),
        text: document.querySelector('.answer-editor')?.value ?? null })`);
      const expected = { writable: true, focused: true, sameEditor: true, sameCards: true, text: 'Keep this typing' };
      assert.deepEqual(await state(), expected);
      await ping('normal');
      await page.evaluate('window.fetch = originalFetch; loadFiles(false)');
      assert.deepEqual(await state(), expected, 'A later successful ping must also preserve the editor');
    });
  });
}
