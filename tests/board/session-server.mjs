import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, stop, until } from './headless-board.mjs';

const skill = fileURLToPath(new URL('../../skills/grillboard/', import.meta.url));
const code = `import sys, time
sys.path.insert(0, sys.argv.pop(1))
import server
class ControlledHandler(server.BoardHandler):
    def dispatch(self):
        if self.path.partition("?")[0] == "/api/ping":
            control = self.server.root / "ping-mode"
            mode = control.read_text() if control.exists() else "normal"
            if mode == "hang":
                time.sleep(30)
                return
            if mode == "legacy":
                self.json_response(200, {"ok": True, "board": 1})
                return
        super().dispatch()
server.BoardHandler = ControlledHandler
sys.exit(server.main())
`;

export async function withSessionServer(check, mode = 'normal') {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-server-lifecycle-'));
  const children = [];
  try {
    await copyFile(path.join(skill, 'viewer.html'), path.join(root, 'index.html'));
    const data = { lang: 'en', title: 'Session A', questions: [{ id: 'q1', title: 'Storage?', status: 'asking',
      options: [{ id: 'a', label: 'Files' }] }] };
    const save = value => writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify(value) + ';\n');
    const ping = mode => writeFile(path.join(root, 'ping-mode'), mode);
    await save(data); await ping(mode);
    async function start(port = '0') {
      const child = spawn('python3', ['-c', code, skill, root, '--serve', '--port', port]);
      children.push(child);
      let output = '';
      child.stdout.on('data', bytes => output += bytes);
      await until(() => output.includes('\n'), 'controlled server startup');
      assert.match(output.trim(), /^http:\/\/127\.0\.0\.1:[0-9]+\/$/);
      return { child, url: output.trim() };
    }
    const { child, url } = await start();
    const page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && currentSession?.title === 'Session A'"), 'initial board');
    await check({ root, child, url, page, ping, save, data, start });
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}
