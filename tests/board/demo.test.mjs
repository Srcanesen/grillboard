import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { browserTest, browser, stop, until } from './headless-board.mjs';

const docs = fileURLToPath(new URL('../../docs/', import.meta.url));
const build = fileURLToPath(new URL('../../tools/build_demo.py', import.meta.url));
const run = promisify(execFile);
const count = '#round-bar .round-count';
const pick = '#round-bar button[aria-label="Pick the recommendations"]';
const send = '#round-bar .send-answers';
const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const viewport = (page, width, height) => page.send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: width < 600
});
const waitFor = (page, selector) => until(() => page.evaluate('!!' + query(selector)), selector);

async function files(folder) {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile())
    .map(entry => path.relative(folder, path.join(entry.parentPath, entry.name))).sort();
}

test('the static demo rebuilds byte for byte', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'grill-demo-build-'));
  const checkedIn = path.join(docs, 'demo');
  try {
    const expected = await files(checkedIn);
    for (let buildNumber = 0; buildNumber < 2; buildNumber++) {
      await run('python3', [build, output]);
      assert.deepEqual(await files(output), expected);
      for (const file of expected) {
        const [actual, committed] = await Promise.all([readFile(path.join(output, file)), readFile(path.join(checkedIn, file))]);
        assert.ok(actual.equals(committed), `Rebuild differs for ${file}`);
      }
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

async function withDemo(check) {
  const profile = await mkdtemp(path.join(tmpdir(), 'grill-demo-chrome-'));
  const children = [];
  try {
    const server = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1', '--directory', docs]);
    children.push(server);
    let output = '';
    server.stdout.on('data', bytes => output += bytes);
    await until(() => /port (\d+)/.test(output), 'static server startup');
    const url = `http://127.0.0.1:${output.match(/port (\d+)/)[1]}/demo/`;
    const page = await browser(profile, children);
    await check(page, url);
  } finally {
    for (const child of children.reverse()) await stop(child);
    await rm(profile, { recursive: true, force: true });
  }
}

browserTest('the static demo replays answers through the spec with the featured working sketch', async () => {
  await withDemo(async (page, url) => {
    await viewport(page, 1440, 900);
    await page.go(url);
    const asking = () => page.evaluate(`Array.from(document.querySelectorAll('.question-card.asking'), card => card.dataset.questionId)`);
    const still = () => until(() => page.evaluate('glideFrame === null && motionFrame === null'), 'board view settles');
    await waitFor(page, pick);
    assert.deepEqual(await asking(), ['q1', 'q2', 'q3']);
    assert.equal(await page.evaluate('document.querySelector(".sketch-card")'), null);

    await page.click(count);
    await page.click('[data-question-id="q1"] [data-answer-option="a"]');
    await page.click(pick);
    await page.click(send);
    await until(() => page.evaluate(`!!document.querySelector('.question-card.pending')`), 'answers are sent');
    await until(() => page.evaluate(`!!document.querySelector('.sketch-card iframe')`), 'first working sketch');
    assert.deepEqual(await asking(), ['q4', 'q5', 'q6', 'q8']);
    assert.equal(await page.evaluate(`document.querySelector('[data-question-id="q1"] .decision-title').lastChild.textContent`),
      'The app is a web app that also works on a phone browser.');
    await still();
    assert.equal(await page.evaluate(`(() => {
      const sketch = document.querySelector('.sketch-card').getBoundingClientRect();
      return sketch.left >= 0 && sketch.right <= innerWidth;
    })()`), true);
    for (let index = 0; index < 4; index++) await page.click(count);
    await page.click('[data-question-id="q8"] [data-answer-option="c"] .option-label');
    assert.equal(await page.evaluate(`document.querySelector('[data-question-id="q8"] [data-answer-option="c"]').getAttribute('aria-checked')`), 'true');
    await page.click(pick);
    await page.click(send);
    await until(async () => (await asking()).includes('q7'), 'third round');
    assert.deepEqual(await asking(), ['q7']);
    const featured = `document.querySelector('.sketch-card iframe')?.srcdoc.includes('Today from our family')`;
    await until(() => page.evaluate(featured), 'the working sketch renders the featured recipe');
    const showLayout = '[data-question-id="q8"] .show-in-sketch';
    await waitFor(page, showLayout);
    await page.evaluate(query(showLayout) + '.click()');
    assert.equal(await page.evaluate(`document.querySelector('.sketch-card iframe').contentDocument
      .querySelector('[data-q="q8"].grill-region-outlined strong, [data-q="q8"].grill-region-outlined h2')?.textContent`),
    "Grandma's apple pie");
    await page.click(pick);
    await page.click(send);
    await until(() => page.evaluate(`document.querySelector('#spec-toggle').getAttribute('aria-expanded') === 'true'`), 'completed spec opens');
    assert.deepEqual(await asking(), []);
    assert.equal(await page.evaluate(`document.querySelectorAll('.question-card.settled').length`), 8);
    const spec = await page.evaluate(`document.querySelector('#spec-content').textContent`);
    assert.match(spec, /The home screen highlights one featured recipe\./);
    assert.match(spec, /Nothing open\./);
    assert.equal(await page.evaluate(featured), true);

    await page.click('#demo-bar button');
    await until(async () => (await asking()).includes('q1'), 'restart returns to the first round');
    assert.deepEqual(await asking(), ['q1', 'q2', 'q3']);
  });
});

browserTest('the demo bar clears the opening idea, header and controls down to 300 px', async () => {
  await withDemo(async (page, url) => {
    const overlaps = [];
    for (const theme of ['light', 'dark']) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      for (const width of [300, 320, 375, 600, 884, 899, 900, 1440]) {
        await viewport(page, width, 812);
        await page.go(url);
        await waitFor(page, pick);
        await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const covered = await page.evaluate(`(() => {
          const barBottom = document.querySelector('#demo-bar').getBoundingClientRect().bottom;
          return ['#header', '.idea-card', '#spec-panel', '#toolbar', '#round-bar', '[data-question-id="q1"]']
            .filter(selector => document.querySelector(selector).getBoundingClientRect().top < barBottom);
        })()`);
        if (covered.length) overlaps.push({ theme, width, covered });
      }
    }
    assert.deepEqual(overlaps, []);
  });
});

browserTest('a second Send during a demo transition acknowledges the first batch without an error', async () => {
  await withDemo(async (page, url) => {
    await page.go(url);
    await waitFor(page, pick);
    // Hold the replay timer so both real Send handlers run during the same transition.
    await page.evaluate(`(() => {
      const schedule = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 1200) return schedule(callback, delay, ...args);
        window.finishDemoTransition = () => callback(...args);
      };
      ${query('[data-question-id="q1"] [data-answer-option="a"]')}.click();
      ${query(send)}.click();
    })()`);
    await until(() => page.evaluate('currentSession.questionsById.q1.pending && !sendingAnswers'), 'first batch pending');
    await page.evaluate(`${query('[data-question-id="q2"] [data-answer-option="a"]')}.click(); ${query(send)}.click()`);
    await until(() => page.evaluate('!sendingAnswers'), 'second Send completes');
    assert.equal(await page.evaluate(query('.round-error') + '?.textContent ?? null'), null);
    assert.deepEqual(await page.evaluate('Object.values(latestUser.answerRequests)'), ['a1', 'a1']);
    assert.deepEqual(await page.evaluate('latestUser.answers'), [{ id: 'a1', items: [{ question: 'q1', option: 'a', text: '' }] }]);
    await page.evaluate('finishDemoTransition()');
    await waitFor(page, '[data-question-id="q4"].asking');
  });
});

browserTest('each settled demo variant links Q8 to its layout region', async () => {
  await withDemo(async (page, url) => {
    await page.go(url);
    await waitFor(page, pick);
    const layouts = await page.evaluate(`Promise.all(['a', 'b', 'c'].map(async variant => {
      const html = await fetch('sketch/settled-q8-' + variant + '.html').then(response => response.text());
      const sketch = new DOMParser().parseFromString(html, 'text/html');
      return [...sketch.querySelectorAll('[data-q="q8"]')].flatMap(region =>
        [...region.querySelectorAll('strong, h2')].map(title => title.textContent));
    }))`);
    assert.deepEqual(layouts, [
      ["Grandma's apple pie", 'Sunday tomato soup', 'Herb flatbread'],
      ['Apple pie', 'Tomato soup', 'Flatbread'],
      ["Grandma's apple pie"]
    ]);
  });
});

browserTest('demo reference notes survive a round change and uploads stay disabled', async () => {
  await withDemo(async (page, url) => {
    await page.go(url);
    await waitFor(page, pick);
    const sendRound = () => page.evaluate(`${query(pick)}.click(); ${query(send)}.click()`);
    await sendRound();
    const note = '[data-note-ref="u2"] button.ref-note';
    await waitFor(page, note);
    await page.evaluate(`${query(note)}.click(); ${query('.note-editor')}.select();`);
    await page.type('Keep this reference for the finished spec.');
    await page.key('Enter');
    await until(() => page.evaluate(`${query(note)}?.textContent === 'Keep this reference for the finished spec.' || !document.querySelector('#toast').hidden`), 'note save completes');
    assert.equal(await page.evaluate(query(note) + '?.textContent'), 'Keep this reference for the finished spec.');
    await sendRound();
    await waitFor(page, '[data-question-id="q7"].asking');
    assert.equal(await page.evaluate(query(note) + '.textContent'), 'Keep this reference for the finished spec.');

    await page.evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['demo'], 'reference.png', {type: 'image/png'}));
      window.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, cancelable: true}));
    })()`);
    await waitFor(page, '.reference-add-reason');
    assert.equal(await page.evaluate(query('.reference-add-reason') + '.textContent'), 'Adding references needs the board server.');
    assert.equal(await page.evaluate('currentSession.userRefs.length'), 2);

    await page.go(url);
    await waitFor(page, pick);
    await sendRound();
    await waitFor(page, note);
    assert.equal(await page.evaluate(query(note) + '.textContent'), 'I like how calm this site feels.');
  });
});

browserTest('the demo fits all opening questions once after a short startup viewport expands', async () => {
  await withDemo(async (page, url) => {
    await viewport(page, 884, 60);
    await page.go(url);
    await waitFor(page, pick);
    const contained = () => page.evaluate(`Array.from(document.querySelectorAll('.question-card.asking'), card => {
      const {left, right, top, bottom} = card.getBoundingClientRect();
      return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
    })`);
    assert.deepEqual(await contained(), [false, false, false]);
    await viewport(page, 884, 1006);
    await until(async () => (await contained()).every(Boolean), 'opening questions fit after viewport expands');
    const fitted = await page.evaluate('({...view})');
    await viewport(page, 884, 940);
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 200))');
    assert.deepEqual(await page.evaluate('({...view})'), fitted);

    await page.go(url);
    await waitFor(page, count);
    await page.click(count);
    const focused = await page.evaluate('({...view})');
    await viewport(page, 884, 1006);
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 200))');
    assert.deepEqual(await page.evaluate('({...view})'), focused);
  });
});
