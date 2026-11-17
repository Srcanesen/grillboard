import assert from 'node:assert/strict';
import { browserTest as test, withBoard } from './headless-board.mjs';

test('custom session languages control document pronunciation independently of bundled label fallbacks', async () => {
  await withBoard({ lang: 'en' }, async ({ page, session }) => {
    await page.evaluate("Object.defineProperty(navigator, 'language', { value: 'tr', configurable: true })");
    const german = { lang: 'de', labels: { idea: 'Idee', asking: 'Jetzt gefragt' } };
    await session(german);
    assert.deepEqual(await page.evaluate('({ session: currentSession.lang, document: document.documentElement.lang, idea: currentLabels.idea })'),
      { session: 'de', document: 'de', idea: 'Idee' });
    await session({ ...german, lang: 'de-DE' });
    assert.equal(await page.evaluate('document.documentElement.lang'), 'de-DE');
    await session({ lang: 'invalid_language' });
    assert.equal(await page.evaluate('document.documentElement.lang'), 'tr');
  });
});
