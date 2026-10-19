import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserTest as test } from './headless-board.mjs';
import { withSessionServer } from './session-server.mjs';

const skill = fileURLToPath(new URL('../../skills/grillboard/', import.meta.url));
// Preserve the pre-request-id reader's exact batch-field contract while exercising
// the real waiter CLI. This models a waiter already running the older Python code.
const oldWaiter = `import sys
sys.path.insert(0, sys.argv.pop(1))
import server
read_user = server.read_user
def old_read_user(root):
    data = read_user(root)
    if any(set(batch) != {"id", "sent", "items"} for batch in data["answers"]):
        raise ValueError("Invalid answer batch in user.js")
    return data
server.read_user = old_read_user
sys.exit(server.main())
`;

for (const mode of ['legacy', 'normal']) {
  test(`a ${mode === 'legacy' ? 'legacy' : 'session-aware'} ping without request-id support keeps answers readable by an older waiter`, async () => {
    await withSessionServer(async ({ root, page }) => {
      // Earlier session-aware pings had the session field, but no capability field.
      await page.evaluate(`(async () => {
        const originalFetch = fetch;
        window.sentRequestIds = [];
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          const address = new URL(args[0]);
          if (address.pathname === '/api/ping') {
            const data = await response.json(); delete data.answerRequestIds;
            return new Response(JSON.stringify(data), { status: response.status });
          }
          if (address.pathname === '/api/answers') sentRequestIds.push(address.searchParams.get('requestId'));
          return response;
        };
        await detectServer();
        document.querySelector('[data-answer-option=a]').click();
        await sendRoundAnswers();
      })()`);
      const waiter = spawnSync('python3', ['-c', oldWaiter, skill, root, '--wait-answers', '--timeout-minutes', '0.001'], { encoding: 'utf8' });
      assert.equal(waiter.status, 0, waiter.stdout + waiter.stderr);
      assert.deepEqual(JSON.parse(waiter.stdout).answers.map(batch => batch.items), [[{ question: 'q1', option: 'a', text: '' }]]);
      assert.deepEqual(await page.evaluate('sentRequestIds'), [null]);
    }, mode);
  });
}
