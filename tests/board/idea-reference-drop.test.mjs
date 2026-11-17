import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

test('external references dropped on the idea highlight it and persist its target', async () => {
  await withBoard({ lang: 'en', title: 'Idea drop', idea: 'An idea' }, async ({ root, page }) => {
    await page.evaluate(`specCollapsed = true; updateSpec(); focusView(false, ['@idea']);
      const card = document.querySelector('.idea-card'), rect = card.getBoundingClientRect();
      window.dropTransfer = new DataTransfer(); dropTransfer.setData('text/plain', location.origin + '/source');
      window.dropEvent = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2, dataTransfer: dropTransfer };
      card.dispatchEvent(new DragEvent('dragover', dropEvent));`);
    // Check both hit-testing paths even when hover alone is broken.
    const highlighted = await page.evaluate("document.querySelector('.idea-card').classList.contains('drop-target')");
    await page.evaluate("document.querySelector('.idea-card').dispatchEvent(new DragEvent('drop', dropEvent))");
    await until(() => page.evaluate('currentUserRefs.length === 1'), 'dropped reference');
    const user = new Function('window', await readFile(path.join(root, 'user.js'), 'utf8') + '; return window.__GRILL_USER__;')({});
    assert.deepEqual({ highlighted, target: user.refs[0].target, anchor: await page.evaluate('currentSession.boardRefs[0].anchorId') },
      { highlighted: true, target: 'idea', anchor: '@idea' });
  });
});
