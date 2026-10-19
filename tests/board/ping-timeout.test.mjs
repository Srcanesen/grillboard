import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until } from './headless-board.mjs';
import { withSessionServer } from './session-server.mjs';

test('a hung ping times out so file polling can show its unreadable warning', async () => {
  await withSessionServer(async ({ root, page, ping }) => {
    await ping('hang');
    await writeFile(path.join(root, 'session.js'), 'This is not a session script.');
    await page.evaluate('window.pollCompleted = false; loadFiles(false).then(() => { pollCompleted = true; }); void 0;');
    await until(() => page.evaluate('pollCompleted'), 'poll must finish despite a hung ping');
    await page.evaluate('(async () => { await loadFiles(false); await loadFiles(false); })()');
    assert.equal(await page.evaluate('warning.hidden'), false);
    assert.match(await page.evaluate('warning.textContent'), /^The session file could not be read\./);
    await ping('normal');
  });
});
