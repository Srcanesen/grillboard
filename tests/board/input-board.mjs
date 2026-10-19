// CDP input reaches focused sandbox frames, unlike synthetic DOM key events.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export async function inputBrowser(profile, children) {
  const executable = process.env.CHROME_BIN || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
  ].find(existsSync);
  const child = spawn(executable, ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-extensions', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  children.push(child);
  let next = 0, buffer = '', mainFrameId;
  const pending = new Map(), contexts = new Map();
  child.stdio[4].on('data', bytes => {
    buffer += bytes.toString();
    let index;
    while ((index = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      if (message.method === 'Target.attachedToTarget') call('Runtime.enable', {}, message.params.sessionId);
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params.context;
        contexts.set(message.sessionId + ':' + context.id, { ...context, sessionId: message.sessionId });
      }
      if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.sessionId + ':' + message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') {
        for (const [key, context] of contexts) if (context.sessionId === message.sessionId) contexts.delete(key);
      }
      if (message.method === 'Target.detachedFromTarget') {
        for (const [key, context] of contexts) if (context.sessionId === message.params.sessionId) contexts.delete(key);
      }
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
  const send = (method, params) => call(method, params, sessionId);
  await send('Runtime.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  async function evaluate(expression, contextId, targetSessionId = sessionId) {
    const result = await call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, targetSessionId);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function mouse(type, x, y, button = 'none', buttons = 0) {
    await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
  }
  return {
    async go(url) { const result = await send('Page.navigate', { url }); mainFrameId = result.frameId; return result; }, evaluate,
    async frameValues(expression) {
      const frames = [...contexts.values()].filter(context => context.auxData?.isDefault && context.auxData.frameId !== mainFrameId);
      const values = await Promise.all(frames.map(async context => {
        try { return await evaluate(expression, context.id, context.sessionId); }
        catch (error) {
          // Navigation can destroy a context between its discovery and evaluation.
          if (!/Cannot find context|Session with given id not found|Inspected target navigated or closed/.test(error.message)) throw error;
        }
      }));
      return values.filter(value => value !== undefined);
    },
    async type(text) { await send('Input.insertText', { text }); },
    async key(key, shift = false) {
      const windowsVirtualKeyCode = { Tab: 9, Escape: 27, Enter: 13 }[key];
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers: shift ? 8 : 0, text: key === 'Enter' ? '\r' : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers: shift ? 8 : 0 });
    },
    async click(selector) {
      const point = await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await mouse('mouseMoved', point.x, point.y);
      await mouse('mousePressed', point.x, point.y, 'left', 1);
      await mouse('mouseReleased', point.x, point.y, 'left', 0);
    },
    async drag(selector, dx, dy) {
      const point = await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await mouse('mouseMoved', point.x, point.y);
      await mouse('mousePressed', point.x, point.y, 'left', 1);
      await mouse('mouseMoved', point.x + dx, point.y + dy, 'left', 1);
      await mouse('mouseReleased', point.x + dx, point.y + dy, 'left', 0);
    }
  };
}
