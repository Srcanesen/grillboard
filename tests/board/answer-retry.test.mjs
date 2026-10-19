import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserTest as test, withBoard } from './headless-board.mjs';

const server = fileURLToPath(new URL('../../skills/grillboard/server.py', import.meta.url));
const data = { lang: 'en', title: 'Answer retries', questions: [{
  id: 'q1', title: 'Storage?', status: 'asking', options: [{ id: 'a', label: 'Files' }]
}] };
const item = { question: 'q1', option: 'a', text: '' };
async function user(root) {
  const text = await readFile(path.join(root, 'user.js'), 'utf8');
  return JSON.parse(text.slice('window.__GRILL_USER__ = '.length).trim().slice(0, -1));
}
async function loseFirstResponse(page) {
  await page.evaluate(`(async () => { window.originalFetch = fetch; window.answerRequests = [];
    window.originalReadScript = readScript;
    // A file-read outage prevents polling from discovering the saved batch before retry.
    readScript = (...args) => args[1] === '__GRILL_USER__' ? Promise.resolve(latestUser) : originalReadScript(...args);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const address = new URL(args[0]);
      if (address.pathname === '/api/answers' && args[1]?.method === 'POST') {
        answerRequests.push({ ...JSON.parse(args[1].body), requestId: address.searchParams.get('requestId') });
        if (answerRequests.length === 1) {
          await response.text();
          throw new TypeError('Answer response lost after commit');
        }
      }
      return response;
    };
    document.querySelector('[data-answer-option=a]').click();
    document.querySelector('.send-answers').click();
    while (sendingAnswers) await new Promise(resolve => setTimeout(resolve, 10)); })()`);
}
async function resend(page) {
  await page.evaluate(`(async () => {
    document.querySelector('.send-answers').click();
    while (sendingAnswers) await new Promise(resolve => setTimeout(resolve, 10));
  })()`);
}

test('resending after a lost saved response persists and delivers only the original batch', async () => {
  await withBoard(data, async ({ root, page }) => {
    await loseFirstResponse(page);
    assert.deepEqual((await user(root)).answers.map(batch => batch.id), ['a1']);
    assert.equal(await page.evaluate('answerError'), 'Could not send answers. Try again.');
    await resend(page);
    assert.deepEqual((await user(root)).answers.map(batch => batch.id), ['a1']);
    const requests = await page.evaluate('answerRequests');
    assert.equal(typeof requests[0].requestId, 'string');
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.deepEqual(await page.evaluate('latestUser.answers[0].items'), [item]);
    const waiter = spawnSync('python3', [server, root, '--wait-answers', '--timeout-minutes', '0.01'], { encoding: 'utf8' });
    assert.equal(waiter.status, 0, waiter.stderr);
    assert.deepEqual(JSON.parse(waiter.stdout).answers.map(batch => batch.id), ['a1']);
  });
});

test('editing a failed batch creates a new request and saves the different answers', async () => {
  await withBoard(data, async ({ root, page }) => {
    await loseFirstResponse(page);
    await page.evaluate(`const editor = document.querySelector('.answer-editor');
      editor.value = 'A different answer'; editor.dispatchEvent(new Event('input'));`);
    await resend(page);
    assert.deepEqual((await user(root)).answers.map(batch => batch.items), [[item], [{ ...item, text: 'A different answer' }]]);
    const requests = await page.evaluate('answerRequests');
    assert.equal(typeof requests[0].requestId, 'string');
    assert.notEqual(requests[0].requestId, requests[1].requestId);
  });
});

test('the same answers sent in a later acknowledged round get a new batch id', async () => {
  await withBoard(data, async ({ root, page, session }) => {
    await page.evaluate(`document.querySelector('[data-answer-option=a]').click(); sendRoundAnswers()`);
    await session({ ...data, answered: 'a1' });
    await page.evaluate(`document.querySelector('[data-answer-option=a]').click(); sendRoundAnswers()`);
    const batches = (await user(root)).answers;
    assert.deepEqual(batches.map(batch => batch.id), ['a1', 'a2']);
    assert.equal(typeof batches[0].requestId, 'string');
    assert.notEqual(batches[0].requestId, batches[1].requestId);
  });
});
