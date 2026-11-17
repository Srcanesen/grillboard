import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserTest as test, browser, devtoolsCommand, serve, stop, until } from './headless-board.mjs';

test('reduced motion disables ordinary question, node and Live-dot update animations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grill-reduced-motion-')), children = [];
  const data = { lang: 'en', questions: [{ id: 'q1', title: 'Storage?', status: 'asking' }] };
  try {
    await copyFile(new URL('../../skills/grillboard/viewer.html', import.meta.url), path.join(root, 'index.html'));
    const save = value => writeFile(path.join(root, 'session.js'), 'window.__GRILL__ = ' + JSON.stringify(value) + ';');
    await save(data);
    const url = await serve(root, children), page = await browser(path.join(root, 'chrome-profile'), children);
    await page.go(url);
    await until(() => page.evaluate("typeof currentSession !== 'undefined' && !!currentSession"), 'board');
    const chrome = children.find(child => child.exitCode === null && child.signalCode === null && child.stdio[3]?.writable && child.stdio[4]?.readable);
    assert.ok(chrome, 'A live Chrome process has a CDP pipe');
    const { targetInfos } = await devtoolsCommand(chrome, 'Target.getTargets');
    const { sessionId } = await devtoolsCommand(chrome, 'Target.attachToTarget', { targetId: targetInfos.find(target => target.url === url).targetId, flatten: true });
    await devtoolsCommand(chrome, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    await save({ ...data, questions: [{ ...data.questions[0], status: 'settled', decision: 'Files' }] });
    await page.evaluate("loadFiles().then(() => nodeRecords.get('@idea').element.classList.add('highlight'))");
    assert.deepEqual(await page.evaluate(`({ preference: matchMedia('(prefers-reduced-motion: reduce)').matches,
      card: getComputedStyle(document.querySelector('.question-card')).animationName,
      node: getComputedStyle(document.querySelector('.idea-card')).animationName,
      dot: getComputedStyle(document.querySelector('.live-dot')).animationName,
      indication: getComputedStyle(document.querySelector('.question-card')).outlineStyle })`),
    { preference: true, card: 'none', node: 'none', dot: 'none', indication: 'solid' });
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
