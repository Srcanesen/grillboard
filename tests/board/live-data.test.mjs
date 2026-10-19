import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const question = {
  id: 'q1', title: 'Storage?', status: 'asking',
  options: [{ id: 'a', label: 'Files' }, { id: 'b', label: 'SQLite' }]
};

test('unrelated saves do not reload mounted option sketches and only changed content reloads', async t => {
  const data = { title: 'Initial', questions: [{ ...question, options: [
    { id: 'a', label: 'Files', sketch: 'option-a.html' },
    { id: 'b', label: 'SQLite', sketch: 'option-b.html' }
  ] }] };
  await withBoard({}, async ({ root, page, session }) => {
    for (const file of ['option-a.html', 'option-b.html']) await writeFile(path.join(root, file), '<html><body>Initial sketch</body></html>');
    await page.evaluate(`window.sketchLoads = { a: 0, b: 0, overlay: 0 };
      document.addEventListener('load', event => {
        if (event.target.tagName !== 'IFRAME') return;
        const option = event.target.closest('[data-answer-option]');
        if (option) sketchLoads[option.dataset.answerOption]++;
        else if (event.target.closest('#lightbox')) sketchLoads.overlay++;
      }, true);`);
    await session(data);
    await until(() => page.evaluate('sketchLoads.a === 1 && sketchLoads.b === 1'), 'initial option loads');
    await page.evaluate('document.querySelector(".variant-open").click()');
    await until(() => page.evaluate('sketchLoads.overlay === 1'), 'initial enlarged option');
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    await page.evaluate(`window.originalSketchFrames = [...document.querySelectorAll('iframe')];
      window.sketchLoads = { a: 0, b: 0, overlay: 0 };
      window.sketchReads = []; window.fetchBeforeSketchCheck = fetch;
      window.fetch = (...args) => {
        const response = fetchBeforeSketchCheck(...args);
        if (/option-[ab]\.html/.test(String(args[0]))) sketchReads.push(response.then(result => result.clone().text()));
        return response;
      };`);
    const settle = () => page.evaluate(`(async () => {
      await Promise.all(sketchReads); sketchReads = [];
      await new Promise(resolve => setTimeout(resolve, 100));
    })()`);
    data.title = 'Unrelated title change';
    await session(data); await settle();
    const unchanged = await page.evaluate('sketchLoads');
    t.diagnostic('Unrelated save reloads: ' + JSON.stringify(unchanged));
    assert.deepEqual(unchanged, { a: 0, b: 0, overlay: 0 });
    assert.equal(await page.evaluate('originalSketchFrames.every((frame, index) => frame === document.querySelectorAll("iframe")[index])'), true);
    await writeFile(path.join(root, 'option-a.html'), '<html><body>Updated option A</body></html>');
    data.architecture = ['Another unrelated session field'];
    await session(data);
    await until(() => page.evaluate('sketchLoads.a === 1 && sketchLoads.overlay === 1'), 'changed option and overlay reload');
    await settle();
    assert.deepEqual(await page.evaluate('sketchLoads'), { a: 1, b: 0, overlay: 1 });
    assert.match(await page.evaluate('document.querySelector("#lightbox iframe").srcdoc'), /Updated option A/);
  });
});

test('removing a selected option prevents submission and preserves the own answer', async () => {
  await withBoard({ questions: [question] }, async ({ root, page, session }) => {
    await page.evaluate('document.querySelector("[data-answer-option=a]").click()');
    await session({ questions: [{ ...question, options: [question.options[1]] }] });
    assert.equal(await page.evaluate('document.querySelector(".send-answers").disabled'), true);
    await page.evaluate('sendRoundAnswers()');
    assert.equal(await page.evaluate('latestUser.answers.length'), 0);
    // Repeat with a written answer: only the removed option must be discarded.
    await session({ questions: [question] });
    await page.evaluate(`document.querySelector('[data-answer-option=a]').click();
      const editor = document.querySelector('.answer-editor');
      editor.value = 'Keep this note'; editor.dispatchEvent(new Event('input'));`);
    await session({ questions: [{ ...question, options: [question.options[1]] }] });
    await page.evaluate('document.querySelector(".send-answers").click()');
    await until(() => page.evaluate('!sendingAnswers && latestUser.answers.length === 1'), 'saved own answer');
    const code = await readFile(path.join(root, 'user.js'), 'utf8');
    const user = new Function('window', code + '; return window.__GRILL_USER__;')({});
    assert.deepEqual(user.answers[0].items, [{ question: 'q1', option: null, text: 'Keep this note' }]);
  });
});

test('an open reader follows a superseding report without accepting an older fetch', async () => {
  const note = { id: 's1', topic: 'Storage', status: 'done', finding: 'Old finding', report: 'old.md' };
  await withBoard({ research: [note] }, async ({ root, page, session }) => {
    await writeFile(path.join(root, 'old.md'), '# Storage\n\nOld report.');
    await writeFile(path.join(root, 'new.md'), '# Updated storage\n\nCorrected report.');
    await page.evaluate(`document.querySelector('.report-card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    await until(() => page.evaluate('readerState.body.textContent === "Old report."'), 'initial report');
    await session({ research: [{ ...note, topic: 'Updated storage', finding: 'Corrected finding', report: 'new.md' }] });
    await until(() => page.evaluate('readerState.body.textContent === "Corrected report."'), 'superseding report');
    assert.equal(await page.evaluate('reader.querySelector("h2").textContent'), 'Updated storage');
    assert.equal(await page.evaluate('new URL(reader.querySelector("a").href).pathname'), '/new.md');
    // Delay an actual old-report fetch until the replacement has finished.
    await page.evaluate(`window.originalFetch = fetch; window.releaseOldReport = null;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]).endsWith('/old.md')) await new Promise(resolve => { window.releaseOldReport = resolve; });
        return response;
      };`);
    await session({ research: [note] });
    await until(() => page.evaluate('!!window.releaseOldReport'), 'delayed old report');
    await session({ research: [{ ...note, report: 'new.md' }] });
    await until(() => page.evaluate('readerState.body.textContent === "Corrected report."'), 'new report during old request');
    await page.evaluate(`(async () => { window.releaseOldReport(); await new Promise(resolve => setTimeout(resolve, 50)); })()`);
    assert.equal(await page.evaluate('readerState.body.textContent'), 'Corrected report.');
    await session({ research: [] });
    assert.equal(await page.evaluate('reader.hidden'), true);
  });
});

test('duplicate ids cannot leave untracked reference, research, report or sketch cards', async () => {
  await withBoard({}, async ({ root, url, page, session }) => {
    await writeFile(path.join(root, 'sketch.html'), '<html><body>Sketch</body></html>');
    const data = {
      refs: [{ id: 'r1', src: url, caption: 'First' }, { id: 'r1', src: url, caption: 'Second' }],
      research: [{ id: 's1', topic: 'First', status: 'done', report: 'first.md' },
        { id: 's1', topic: 'Second', status: 'done', report: 'second.md' }],
      sketches: [{ id: 'k1', src: 'sketch.html' }, { id: 'k1', src: 'sketch.html', rev: 2 }]
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      await session(data);
      assert.deepEqual(await page.evaluate(`['.reference-card', '.research-card', '.report-card', '.sketch-card']
        .map(selector => document.querySelectorAll(selector).length)`), [1, 1, 1, 1]);
      await session({});
      assert.equal(await page.evaluate('world.querySelectorAll(".node").length'), 1, 'Only the idea remains');
    }
  });
});

test('sparse session entries do not freeze the current or later update', async () => {
  await withBoard({ title: 'Initial' }, async ({ page, session }) => {
    await session('{title:"Sparse", refs:[, {id:"r1", src:"refs/picture.svg"}], research:[, {id:"s1", topic:"Storage"}]}');
    assert.equal(await page.evaluate('header.querySelector("h1").textContent'), 'Sparse');
    assert.equal(await page.evaluate('document.querySelectorAll(".reference-card").length'), 1);
    await session({ title: 'Next update' });
    assert.equal(await page.evaluate('header.querySelector("h1").textContent'), 'Next update');
  });
});

test('main, option and enlarged sketches follow revised files while unchanged frames stay mounted', async () => {
  const data = { questions: [{ ...question, options: [{ id: 'a', label: 'Files', sketch: 'option.html' }] }],
    sketches: [{ id: 'k1', src: 'main.html', title: 'Main', rev: 1 }] };
  await withBoard({}, async ({ root, page, session }) => {
    for (const file of ['main.html', 'option.html']) await writeFile(path.join(root, file), '<html><body>Before</body></html>');
    await session(data);
    await page.evaluate('openEnlargedSketch("k1")');
    await until(() => page.evaluate('[...document.querySelectorAll("iframe")].every(frame => frame.srcdoc.includes("Before"))'), 'initial sketches');
    await page.evaluate('window.unchangedFrame = document.querySelector(".sketch-card iframe")');
    data.title = 'Updated session title';
    await session(data);
    assert.equal(await page.evaluate('window.unchangedFrame === document.querySelector(".sketch-card iframe")'), true);
    for (const file of ['main.html', 'option.html']) await writeFile(path.join(root, file), '<html><body>After</body></html>');
    data.sketches[0].rev = 2;
    await session(data);
    await until(() => page.evaluate('[...document.querySelectorAll("iframe")].every(frame => frame.srcdoc.includes("After"))'), 'all revised frames');
    assert.equal(await page.evaluate('enlargedSketch.sketch.rev'), 2);
    // Open the variant from the reused card, then change only other session content.
    await page.evaluate('closeLightbox(); document.querySelector(".variant-open").click()');
    await until(() => page.evaluate('document.querySelector("#lightbox iframe").srcdoc.includes("After")'), 'current option open button');
    await writeFile(path.join(root, 'option.html'), '<html><body>Third version</body></html>');
    data.architecture = ['A newly settled decision'];
    await session(data);
    await until(() => page.evaluate('document.querySelector(".variant-preview iframe").srcdoc.includes("Third version") && document.querySelector("#lightbox iframe").srcdoc.includes("Third version")'), 'option preview and overlay');
    assert.match(await page.evaluate('document.querySelector(".sketch-card iframe").srcdoc'), /After/);
  });
});

test('an image URL without an extension becomes an option picture and ordinary links stay links', async () => {
  await withBoard({}, async ({ root, url, page, session }) => {
    await mkdir(path.join(root, 'refs'));
    await writeFile(path.join(root, 'refs/image'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==', 'base64'));
    await session({ questions: [question], refs: [
      { id: 'r1', src: url + 'refs/image', target: 'q1:a' }, { id: 'r2', src: url, target: 'idea' }
    ] });
    await until(() => page.evaluate('document.querySelector(".tile-picture img")?.naturalWidth === 1'), 'decoded option image');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".reference-card")].map(card => card.dataset.refId)'), ['r2']);
    assert.equal(await page.evaluate('document.querySelectorAll(".reference-card .ref-open").length'), 1);
  });
});
