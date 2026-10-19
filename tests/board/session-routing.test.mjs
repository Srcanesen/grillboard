import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const skill = fileURLToPath(new URL('../../skills/grillboard/', import.meta.url));
const item = { question: 'q1', option: 'b', text: '' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('Timed out: ' + message);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await done; } finally { clearTimeout(timer); }
}
async function serve(dir, children) {
  let port;
  do {
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
  } while (port <= 9000);
  const child = spawn('python3', [path.join(skill, 'server.py'), dir, '--serve', '--port', String(port)]);
  children.push(child);
  let output = '';
  child.stdout.on('data', bytes => output += bytes);
  await until(() => output.includes('http://'), 'server startup');
  return `http://127.0.0.1:${port}/`;
}
async function browser(profile, children) {
  const executable = process.env.CHROME_BIN || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
  ].find(existsSync);
  assert.ok(executable, 'Headless Chrome is required (or set CHROME_BIN)');
  const child = spawn(executable, ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-extensions', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  children.push(child);
  let next = 0, buffer = '';
  const pending = new Map();
  child.stdio[4].on('data', bytes => {
    buffer += bytes.toString();
    let index;
    while ((index = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  function call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 6000);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  return {
    go: url => call('Page.navigate', { url }, sessionId),
    async evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
  };
}
async function answers(dir) {
  const text = await readFile(path.join(dir, 'user.js'), 'utf8');
  return JSON.parse(text.slice('window.__GRILL_USER__ = '.length).trim().slice(0, -1)).answers;
}

test('alternate session directories are read-only and each served board saves to its own session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-routing-'));
  const children = [];
  try {
    const other = path.join(root, 'other');
    await mkdir(other);
    for (const [dir, title] of [[root, 'Parent session'], [other, 'Other session']]) {
      await copyFile(path.join(skill, 'viewer.html'), path.join(dir, 'index.html'));
      await writeFile(path.join(dir, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
        version: 1, lang: 'en', title, idea: title, questions: [{
          id: 'q1', round: 1, title: 'Storage?', status: 'asking', options: [
            { id: 'a', label: 'Files' }, { id: 'b', label: 'SQLite' }
          ]
        }]
      }) + ';\n');
    }
    const parentUrl = await serve(root, children), otherUrl = await serve(other, children);
    const page = await browser(path.join(root, 'chrome-profile'), children);
    const ready = title => until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession?.title === ${JSON.stringify(title)}`), 'board render');
    await page.go(parentUrl + '?session=other/session.js');
    await ready('Other session');
    // On the broken board these controls send an answer to the parent session.
    const sent = await page.evaluate(`(async () => {
      const option = document.querySelector('[data-answer-option=b]');
      const send = document.querySelector('.send-answers');
      if (!option || !send) return false;
      option.click(); document.querySelector('.send-answers').click();
      while (sendingAnswers) await new Promise(resolve => setTimeout(resolve, 10));
      return true;
    })()`);
    assert.deepEqual(await answers(root), [], 'Displaying another directory must not write parent answers');
    assert.deepEqual(await answers(other), []);
    assert.equal(sent, false, 'Alternate directories have no send controls');
    assert.equal(await page.evaluate('roundBar.hidden'), true);
    assert.equal(await page.evaluate(`apiRequest('api/answers', 'POST', { items: [${JSON.stringify(item)}] }).then(() => false, () => true)`), true);
    assert.deepEqual(await answers(root), []);

    await page.go(otherUrl);
    await ready('Other session');
    assert.equal(await page.evaluate(`document.querySelector('.read-only-notice')`), null);
    await page.evaluate(`document.querySelector('[data-answer-option=b]').click(); document.querySelector('.send-answers').click()`);
    await until(async () => (await answers(other)).length === 1, 'displayed session answer');
    assert.deepEqual((await answers(other)).map(batch => batch.items), [[item]]);
    assert.deepEqual(await answers(root), []);
    const waiter = spawnSync('python3', [path.join(skill, 'server.py'), other, '--wait-answers', '--timeout-minutes', '0.001'], { encoding: 'utf8' });
    assert.equal(waiter.status, 0, waiter.stderr);
    assert.deepEqual(JSON.parse(waiter.stdout).answers.map(batch => batch.items), [[item]]);

    // Every explicit session is read-only, even when it names the root session.
    await page.go(parentUrl + 'other/index.html?session=/session.js');
    await ready('Parent session');
    assert.equal(await page.evaluate('roundBar.hidden'), true);
    assert.deepEqual(await answers(root), []);
    assert.deepEqual((await answers(other)).map(batch => batch.items), [[item]]);
    // A nested copy without an API beside it must not write to the parent API.
    await page.go(parentUrl + 'other/index.html');
    await ready('Other session');
    assert.equal(await page.evaluate('roundBar.hidden'), true);
    assert.deepEqual(await answers(root), []);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('encoded session paths cannot send the displayed session answer to its parent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-encoded-routing-'));
  const children = [];
  try {
    const other = path.join(root, 'other');
    await mkdir(other);
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    for (const [dir, title] of [[root, 'Parent session'], [other, 'Other session']]) {
      await writeFile(path.join(dir, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
        version: 1, lang: 'en', title, idea: title, questions: [{
          id: 'q1', round: 1, title: 'Storage?', status: 'asking', options: [{ id: 'b', label: 'SQLite' }]
        }]
      }) + ';\n');
    }
    const parentUrl = await serve(root, children);
    const otherUrl = await serve(other, children);
    const savedItem = { question: 'q1', option: 'b', text: 'Other session answer' };
    const saved = await fetch(otherUrl + 'api/answers', { method: 'POST',
      headers: { 'X-Grill-Board': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [savedItem] }) });
    assert.equal(saved.status, 200);
    const page = await browser(path.join(root, 'chrome-profile'), children);
    for (const parameter of ['other%252Fsession.js', 'other%255Csession.js', '%256Fther%252fsession.js', 'other%252F..%252Fother%252Fsession.js']) {
      await page.go(parentUrl + '?session=' + parameter);
      await until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession?.title === 'Other session'`), 'encoded session render');
      await page.evaluate(`(async () => {
        const option = document.querySelector('[data-answer-option=b]');
        if (!document.querySelector('.send-answers')) return;
        option.click(); document.querySelector('.send-answers').click();
        while (sendingAnswers) await new Promise(resolve => setTimeout(resolve, 10));
      })()`);
      assert.deepEqual(await answers(root), [], parameter + ' must not write parent answers');
      assert.deepEqual((await answers(other)).map(batch => batch.items), [[savedItem]]);
      assert.deepEqual(await page.evaluate('currentSession.questionsById.q1.pendingItem'), savedItem);
      assert.equal(await page.evaluate('roundBar.hidden'), true);
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only boards explain how to answer and keep research logs and full reports live', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-read-only-'));
  const children = [];
  try {
    const other = path.join(root, 'other');
    await mkdir(path.join(other, 'research'), { recursive: true });
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    await writeFile(path.join(other, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
      version: 1, lang: 'en', title: 'Other session', idea: 'Research access', research: [
        { id: 's1', topic: 'Storage constraints', status: 'running' },
        { id: 's2', topic: 'Storage report', status: 'done', finding: 'Short finding.', report: 'research/s2.md' }
      ]
    }) + ';\n');
    await writeFile(path.join(other, 'research/s1.log'), 'Reading storage limits\n');
    await writeFile(path.join(other, 'research/s2.md'), '# Storage report\n\nFull report details beyond the short finding.\n');
    const url = await serve(root, children);
    await serve(other, children);
    const page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url + '?session=other/session.js');
    await until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession?.title === 'Other session'`), 'read-only board');
    await until(() => page.evaluate(`document.querySelector('.research-step')?.textContent.includes('Reading storage limits')`), 'initial research log');
    await writeFile(path.join(other, 'research/s1.log'), 'Updated storage limits\n');
    await until(() => page.evaluate(`document.querySelector('.research-step')?.textContent.includes('Updated storage limits')`), 'live research log update');
    await page.evaluate(`document.querySelector('.report-card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await until(() => page.evaluate(`document.querySelector('#reader').textContent.includes('Full report details beyond the short finding.')`), 'full research report');
    assert.equal(await page.evaluate(`document.querySelector('.read-only-notice')?.textContent`),
      'Read-only. Ask the agent to open this session’s board so you can answer.');
    assert.deepEqual(await answers(root), []);
    assert.deepEqual(await answers(other), []);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('literal-percent session paths never fall back to a writable parent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-percent-'));
  const children = [];
  try {
    const other = path.join(root, 'other%');
    await mkdir(other);
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    for (const [dir, title] of [[root, 'Parent session'], [other, 'Percent session']]) {
      await writeFile(path.join(dir, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
        version: 1, lang: 'en', title, idea: title, questions: [{
          id: 'q1', round: 1, title: 'Storage?', status: 'asking', options: [{ id: 'b', label: 'SQLite' }]
        }]
      }) + ';\n');
    }
    const url = await serve(root, children);
    await serve(other, children);
    const page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url + '?session=other%25%2Fsession.js');
    await until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession !== null`), 'percent session render');
    await page.evaluate(`(async () => {
      if (!document.querySelector('.send-answers')) return;
      document.querySelector('[data-answer-option=b]').click(); document.querySelector('.send-answers').click();
      while (sendingAnswers) await new Promise(resolve => setTimeout(resolve, 10));
    })()`);
    assert.deepEqual(await answers(root), [], 'Literal percent must not save answers to the parent');
    assert.equal(await page.evaluate('document.querySelector("#header h1").textContent'), 'Percent session');
    assert.equal(await page.evaluate('roundBar.hidden'), true);
    assert.deepEqual(await answers(other), []);
    for (const query of ['session', 'session=', 'session=session.js', 'session=./session.js', 'session=/session.js', '%73ession=session.js', 'session=session.js&session=other/session.js']) {
      await page.go(url + '?' + query);
      await until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession?.title === 'Parent session'`), 'query session render');
      assert.equal(await page.evaluate('roundBar.hidden'), true, query + ' must be read-only');
      assert.equal(await page.evaluate(`apiRequest('api/answers', 'POST', { items: [${JSON.stringify(item)}] }).then(() => false, () => true)`), true);
      assert.deepEqual(await answers(root), []);
    }
    for (const query of ['session=%E0%A4%A', 'session=http%3A%2F%2F%5Binvalid', 'session=https%3A%2F%2Fexample.com%2Fsession.js']) {
      await page.go(url + '?' + query);
      await until(() => page.evaluate(`!document.querySelector('#warning').hidden`), 'invalid session error');
      assert.match(await page.evaluate('document.querySelector("#warning").textContent'), /^(The session URL is invalid\.|Oturum adresi geçersiz\.)$/);
      assert.equal(await page.evaluate('document.querySelector("#board").hidden'), true);
      assert.deepEqual(await answers(root), []);
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only cards show incoming pending answers and Sent without reloading', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-incoming-'));
  const children = [];
  try {
    const other = path.join(root, 'other');
    await mkdir(other);
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    await copyFile(path.join(skill, 'viewer.html'), path.join(other, 'index.html'));
    const data = { version: 1, lang: 'en', title: 'Other session', idea: 'Incoming answers', questions: [{
      id: 'q1', round: 1, title: 'Storage?', status: 'asking', options: [
        { id: 'a', label: 'Files' }, { id: 'b', label: 'SQLite' }
      ]
    }] };
    await writeFile(path.join(other, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify(data) + ';\n');
    const url = await serve(root, children), otherUrl = await serve(other, children);
    const page = await browser(path.join(root, 'chrome-profile'), children);
    for (const [boardUrl, readOnly] of [[url + '?session=other/session.js', true], [otherUrl, false]]) {
      await page.go(boardUrl);
      await until(() => page.evaluate(`typeof currentSession !== 'undefined' && currentSession?.title === 'Other session'`), 'read-only initial render');
      assert.equal(await page.evaluate(`document.querySelector('.pending-badge')`), null);
      for (const incoming of [{ question: 'q1', option: 'b', text: 'From the writable board' }, { question: 'q1', option: 'a', text: 'Updated answer' }]) {
        const response = await fetch(otherUrl + 'api/answers', { method: 'POST',
          headers: { 'X-Grill-Board': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [incoming] }) });
        assert.equal(response.status, 200);
        await page.evaluate('loadFiles()');
        assert.equal(await page.evaluate(`document.querySelector('.pending-badge')?.textContent`), 'Sent');
        assert.equal(await page.evaluate(`document.querySelector('.question-card').classList.contains('pending')`), true);
        assert.equal(await page.evaluate(`document.querySelector('.option.picked .option-label')?.textContent`), incoming.option === 'b' ? 'SQLite' : 'Files');
        assert.equal(await page.evaluate(`document.querySelector('.answer-editor')?.value`), incoming.text);
        assert.equal(await page.evaluate(`document.querySelector('.answer-editor')?.readOnly`), true);
        assert.equal(await page.evaluate('roundBar.hidden'), readOnly);
      }
      data.answered = readOnly ? 'a2' : 'a4';
      await writeFile(path.join(other, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify(data) + ';\n');
      await page.evaluate('loadFiles()');
      assert.equal(await page.evaluate(`document.querySelector('.pending-badge')`), null);
      assert.equal(await page.evaluate(`document.querySelector('.question-card').classList.contains('pending')`), false);
    }
    assert.deepEqual(await answers(root), []);
    assert.deepEqual((await answers(other)).map(batch => batch.items[0].text), ['From the writable board', 'Updated answer', 'From the writable board', 'Updated answer']);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('disk boards render without a notice promising a writable board', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-disk-'));
  const children = [];
  try {
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    await writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify({
      version: 1, lang: 'en', title: 'Disk session', idea: 'Read from disk', questions: [{
        id: 'q1', round: 1, title: 'Storage?', status: 'asking', options: [{ id: 'b', label: 'SQLite' }]
      }]
    }) + ';\n');
    const page = await browser(path.join(root, 'chrome-profile'), children);
    for (const query of ['', '?session=session.js']) {
      await page.go(pathToFileURL(path.join(root, 'index.html')).href + query);
      await until(() => page.evaluate(`document.querySelector('#header h1')?.textContent === 'Disk session'`), 'disk board render');
      assert.equal(await page.evaluate(`document.querySelector('.read-only-notice')?.textContent || ''`), '');
      assert.equal(await page.evaluate('roundBar.hidden'), true);
      assert.equal(await page.evaluate(`document.querySelector('.send-answers')`), null);
    }
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
