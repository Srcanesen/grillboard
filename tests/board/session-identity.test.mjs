import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserTest as test, browser, serve, stop, until } from './headless-board.mjs';

const skill = fileURLToPath(new URL('../../skills/grillboard/', import.meta.url));
const item = { question: 'q1', option: 'a', text: '' };
const notice = 'This server now serves another session. Ask the agent to reopen this board.';

async function withTakeover(check) {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-identity-'));
  const children = [];
  try {
    const other = path.join(root, 'other');
    await mkdir(other);
    for (const [dir, title] of [[root, 'Session A'], [other, 'Session B']]) {
      await copyFile(path.join(skill, 'viewer.html'), path.join(dir, 'index.html'));
      await writeFile(path.join(dir, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
        lang: 'en', title, questions: [{ id: 'q1', title: 'Storage?', status: 'asking',
          options: [{ id: 'a', label: 'Files' }] }]
      }) + ';\n');
    }
    const url = await serve(root, children);
    const first = children[0];
    const page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && currentSession?.title === 'Session A' && canWrite"), 'session A');
    const takeover = async () => {
      await stop(first);
      const child = spawn('python3', [path.join(skill, 'server.py'), other, '--serve', '--port', new URL(url).port]);
      children.push(child);
      let output = '';
      child.stdout.on('data', bytes => output += bytes);
      await until(() => output.includes('\n'), 'session B on reused port');
      assert.equal(output.trim(), url);
    };
    const user = async () => {
      const text = await readFile(path.join(other, 'user.js'), 'utf8');
      return JSON.parse(text.slice('window.__GRILL_USER__ = '.length).trim().slice(0, -1));
    };
    await check({ page, takeover, user });
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}

test('polling a reused port preserves session A and makes its board read-only', async () => {
  await withTakeover(async ({ page, takeover, user }) => {
    await takeover();
    await page.evaluate('loadFiles()');
    assert.equal(await page.evaluate('currentSession.title'), 'Session A');
    assert.equal(await page.evaluate('canWrite'), false);
    assert.equal(await page.evaluate('roundBar.hidden'), true);
    assert.equal(await page.evaluate("document.querySelector('.read-only-notice')?.textContent"), notice);
    assert.deepEqual((await user()).answers, []);
  });
});

test('answers and references sent during port takeover never reach session B', async () => {
  await withTakeover(async ({ page, takeover, user }) => {
    // Pause each real mutation after any client-side check, then replace its server.
    await page.evaluate(`window.originalFetch = fetch; window.releaseWrites = [];
      window.fetch = async (...args) => {
        if (args[1]?.method === 'POST') await new Promise(resolve => { window.releaseWrites.push(resolve); });
        return originalFetch(...args);
      };
      window.writeResult = apiRequest('api/answers', 'POST', { items: [${JSON.stringify(item)}] }).then(() => true, () => false);
      window.refResult = apiRequest('api/refs', 'POST', { url: 'https://example.com', target: '' }).then(() => true, () => false);
      void 0;`);
    await until(() => page.evaluate('window.releaseWrites.length === 2'), 'paused answer and reference requests');
    await takeover();
    assert.deepEqual(await page.evaluate('(async () => { releaseWrites.forEach(release => release()); return await Promise.all([writeResult, refResult]); })()'), [false, false]);
    assert.deepEqual((await user()).answers, []);
    assert.deepEqual((await user()).refs, []);
    assert.equal(await page.evaluate('canWrite'), false);
  });
});

test('a takeover between ping and script reads cannot replace the displayed session', async () => {
  await withTakeover(async ({ page, takeover }) => {
    await page.evaluate(`window.originalReadScript = readScript; window.releaseReads = [];
      readScript = async (...args) => {
        await new Promise(resolve => releaseReads.push(resolve));
        return originalReadScript(...args);
      };
      window.readResult = loadFiles(); void 0;`);
    await until(() => page.evaluate('releaseReads.length === 2'), 'paused session and user reads');
    await takeover();
    await page.evaluate('(async () => { releaseReads.forEach(release => release()); await readResult; })()');
    assert.equal(await page.evaluate('currentSession.title'), 'Session A');
    assert.equal(await page.evaluate('canWrite'), false);
    assert.equal(await page.evaluate("document.querySelector('.read-only-notice')?.textContent"), notice);
  });
});
