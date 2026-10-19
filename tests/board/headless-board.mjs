import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = fileURLToPath(new URL('../../skills/grillboard/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, message) {
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
  for (port = 9200; port < 9300; port++) {
    const socket = net.createServer();
    try { await new Promise((resolve, reject) => socket.once('error', reject).listen(port, '127.0.0.1', resolve)); }
    catch { continue; }
    await new Promise(resolve => socket.close(resolve)); break;
  }
  assert.ok(port < 9300, 'No free board test port');
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

export async function withBoard(initial, check) {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-live-data-'));
  const children = [];
  try {
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    const save = value => writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' +
      (typeof value === 'string' ? value : JSON.stringify(value)) + ';\n');
    await save(initial);
    const url = await serve(root, children);
    const page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && !!currentSession"), 'board render');
    const session = async value => { await save(value); await page.evaluate('loadFiles()'); };
    await check({ root, url, page, session });
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}
