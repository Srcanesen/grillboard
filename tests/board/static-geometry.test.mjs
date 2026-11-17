import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserTest as test, browser, stop, until } from './headless-board.mjs';

const staticServer = `from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys
server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=sys.argv[1]))
print("http://127.0.0.1:%d/" % server.server_port, flush=True)
server.serve_forever()
`;

test('an HTTP board without api/ping restores positions and sizes after reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-static-geometry-')), children = [];
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    await writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = {lang:"en",title:"Static session",questions:[{id:"q1",title:"Storage?",status:"asking"}]};');
    await writeFile(path.join(root, 'user.js'), 'window.__GRILL_USER__ = {refs:[],answers:[]};');
    const server = spawn('python3', ['-c', staticServer, root]); children.push(server);
    let output = ''; server.stdout.on('data', bytes => output += bytes);
    await until(() => output.includes('\n'), 'static server');
    const url = output.trim(), page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && currentSession?.title === 'Static session'"), 'static board');
    assert.equal(await page.evaluate("fetch(new URL('api/ping', location.href)).then(response => response.status)"), 404);
    await page.evaluate(`manualOffsets.q1 = { dx: 123, dy: 45 }; saveOffsets();
      const handle = nodeRecords.get('q1').element.resizeHandle;
      for (let i = 0; i < 3; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));`);
    const previousLoad = await page.evaluate('performance.timeOrigin');
    await page.go(url);
    await until(() => page.evaluate(`performance.timeOrigin !== ${previousLoad} && typeof currentSession !== 'undefined' && currentSession?.title === 'Static session'`), 'static board reload');
    assert.deepEqual(await page.evaluate("({ offset: manualOffsets.q1 || null, width: nodeSizes.q1 || null, renderedWidth: nodeRecords.get('q1').width })"),
      { offset: { dx: 123, dy: 45 }, width: 360, renderedWidth: 360 });
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
