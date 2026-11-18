import assert from 'node:assert/strict';
import { browserTest as test, until, withBoard } from './headless-board.mjs';

const data = {
  title: 'Recipe box',
  questions: [
    { id: 'q1', status: 'asking', title: 'Where should recipes be stored?',
      body: 'Keep the recipes on the device, or share them with the family so everyone can edit them.' },
    { id: 'q2', status: 'waiting', title: 'Sharing', dependsOn: ['q1'] },
    { id: 'q3', status: 'settled', title: 'Photos', decision: 'A recipe can have a photo.' },
    { id: 'q4', status: 'researching', title: 'Import' }
  ],
  refs: [{ id: 'guide', src: 'guide.html' }, { id: 'photo', src: 'photo.svg', kind: 'image' }],
  research: [
    { id: 'r1', topic: 'Desktop editors', status: 'done', target: 'q1', report: 'report.md' },
    { id: 'r2', topic: 'Recipe formats', status: 'todo' }
  ],
  sketches: [{ id: 'home', src: 'home.html', width: 300, height: 250 }]
};
const card = '[data-question-id="q1"]';
const node = 'nodeRecords.get("q1")';
const box = `(() => {
  const { element, x, y, width, height } = ${node};
  const rect = element.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height, x, y, width, height];
})()`;
const handles = [
  ['n', 24, -20, [300, 230, 300, 300], 'ns-resize'],
  ['s', 24, 20, [300, 250, 300, 300], 'ns-resize'],
  ['w', -40, 24, [260, 250, 340, 280], 'ew-resize'],
  ['e', 40, 24, [300, 250, 340, 280], 'ew-resize'],
  ['nw', -40, -20, [260, 230, 340, 300], 'nwse-resize'],
  ['ne', 40, -20, [300, 230, 340, 300], 'nesw-resize'],
  ['sw', -40, 20, [260, 250, 340, 300], 'nesw-resize'],
  ['se', 40, 20, [300, 250, 340, 300], 'nwse-resize']
];

async function prepare(page) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.evaluate('specCollapsed = true; updateSpec()');
}

async function centerCard(page) {
  await page.evaluate(`glideView({ x: 300 - ${node}.x, y: 250 - ${node}.y, z: 1 }, false)`);
}

async function handlePoint(page, edge, parent = card) {
  const selector = `${parent} > [data-resize="${edge}"]`;
  const [x, y, hit, target] = await page.evaluate(`(() => {
    const handle = document.querySelector(${JSON.stringify(selector)});
    const rect = handle.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    const target = document.elementFromPoint(x, y);
    return [x, y, target === handle, target === handle ? '' : JSON.stringify(document.elementsFromPoint(x, y).slice(0, 5)
      .map(el => [el.className, el.closest('.node')?.dataset.nodeId, el.getBoundingClientRect().toJSON()]))];
  })()`);
  assert.equal(hit, true, edge + ' handle receives the pointer above ' + target);
  return { x, y };
}

async function mouse(page, type, point, clickCount = 1) {
  await page.send('Input.dispatchMouseEvent', {
    type, ...point, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount
  });
}

async function dragHandle(page, edge, dx, dy, duringDrag) {
  const start = await handlePoint(page, edge);
  const end = { x: start.x + dx, y: start.y + dy };
  await mouse(page, 'mousePressed', start);
  await mouse(page, 'mouseMoved', end);
  if (duringDrag) {
    await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    await duringDrag();
  }
  await mouse(page, 'mouseReleased', end);
}

test('all eight question handles resize the rectangle around the opposite edge', async () => {
  await withBoard(data, async ({ page }) => {
    await prepare(page);
    assert.deepEqual(await page.evaluate(`[...world.querySelectorAll('.node')].map(node => node.querySelectorAll(':scope > .node-resize').length)`),
      [8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
    for (const [edge, dx, dy, expected, cursor] of handles) {
      await page.evaluate(`nodeSizes.q1 = { width: 300, height: 280 }; applyNodeSize(${node}); measureAndLayout()`);
      await centerCard(page);
      assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('${card} > [data-resize="${edge}"]')).cursor`), cursor);
      const before = await page.evaluate(box);
      assert.deepEqual(before.slice(0, 4), [300, 250, 300, 280]);
      const assertBox = async () => {
        const result = await page.evaluate(box);
        assert.deepEqual(result.slice(0, 4), expected, edge);
        assert.deepEqual([result[4] - before[4] + 300, result[5] - before[5] + 250, ...result.slice(6)], expected, edge);
      };
      await dragHandle(page, edge, dx, dy, assertBox);
      await assertBox();
    }
    assert.deepEqual(await page.evaluate('[view.z, selectedQuestion, manualOffsets.q1 || null, getSelection().toString()]'), [1, '', null, '']);
  });
});

test('short report grips stay inside the card, respect the thickness limit and disappear in far view', async () => {
  await withBoard(data, async ({ page }) => {
    await prepare(page);
    for (const [zoom, thickness] of [[1, 10], [.5, 8]]) {
      assert.deepEqual(await page.evaluate(`(() => {
        nodeSizes['report:r1'] = { width: 300, height: 64 };
        measureAndLayout();
        const report = nodeRecords.get('report:r1');
        glideView({ x: 350 - report.x * ${zoom}, y: 350 - report.y * ${zoom}, z: ${zoom} }, false);
        const card = report.element.getBoundingClientRect();
        const handles = [...report.element.querySelectorAll('.node-resize')].map(handle => handle.getBoundingClientRect());
        const size = (selector, axis) => report.element.querySelector(selector).getBoundingClientRect()[axis];
        return [size('.resize-n', 'height'), size('.resize-w', 'width'), size('.resize-nw', 'width'), size('.resize-nw', 'height'),
          handles.filter(h => h.left < card.left || h.right > card.right || h.top < card.top || h.bottom > card.bottom).length];
      })()`), [thickness, thickness, thickness, thickness, 0]);
      for (const [edge] of handles) await handlePoint(page, edge, '.report-card');
      await page.click('.report-card h3');
      assert.equal(await page.evaluate('reader.hidden'), false);
      await page.key('Escape');
    }
    await page.evaluate('glideView({ ...view, z: .4 }, false)');
    assert.deepEqual(await page.evaluate(`[world.classList.contains('far'),
      [...world.querySelectorAll('.node-resize')].filter(handle => handle.getClientRects().length).length]`), [true, 0]);
  });
});

test('resize frames move descendants and cables before release while the handle tracks the pointer', async () => {
  await withBoard(data, async ({ page }) => {
    await prepare(page);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.evaluate(`nodeSizes.q1 = { width: 300, height: 280 }; applyNodeSize(${node}); measureAndLayout();
      window.childStart = nodeRecords.get('q2').y`);
    await centerCard(page);
    const start = await handlePoint(page, 's');
    await mouse(page, 'mousePressed', start);
    for (const [dy, height] of [[180, 460], [320, 600]]) {
      const end = { x: start.x, y: start.y + dy };
      await mouse(page, 'mouseMoved', end);
      await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
      assert.deepEqual(await page.evaluate(`(() => {
        const child = nodeRecords.get('q2'), report = nodeRecords.get('report:r1');
        const cable = world.querySelector('[data-from="report:r1"][data-to="q2"]');
        const end = cable.getPointAtLength(cable.getTotalLength());
        const hit = document.elementFromPoint(${end.x}, ${end.y});
        return [${node}.height, child.y - childStart, child.y - report.y - report.height,
          end.y - child.y, hit === nodeResize.handle, motionFrame, glideFrame];
      })()`), [height, dy, 64, 0, true, null, null]);
    }
    await mouse(page, 'mouseReleased', { x: start.x, y: start.y + 320 });
    assert.equal(await page.evaluate("nodeRecords.get('q2').y - childStart"), 320);
  });
});

test('manual sizes reflow content, make room in the layout, survive reload and reset on double-click', async () => {
  await withBoard(data, async ({ page, url }) => {
    await prepare(page);
    await centerCard(page);
    const automatic = await page.evaluate(box);
    await dragHandle(page, 'se', -200, -240);
    const minimum = await page.evaluate(box);
    assert.equal(minimum[2], 200);
    assert.deepEqual(await page.evaluate(`(() => {
      const card = ${node}.element, body = card.querySelector('.question-body');
      const padding = parseFloat(getComputedStyle(card).borderBottomWidth);
      return [Math.round(card.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom - padding),
        Math.round(body.scrollHeight - body.clientHeight)];
    })()`), [0, 0]);
    assert.equal(minimum[3] > automatic[3], true, 'narrower text raises the minimum height');

    await dragHandle(page, 'se', 490, 520 - minimum[3], async () => {
      assert.deepEqual(await page.evaluate(`(() => {
        const card = ${node};
        const cable = world.querySelector('[data-from="@idea"][data-to="q1"]');
        const point = cable.getPointAtLength(cable.getTotalLength());
        return [point.x - card.x, point.y - card.y, motionFrame];
      })()`), [345, 0, null]);
    });
    assert.deepEqual((await page.evaluate(box)).slice(0, 4), [300, 250, 690, 520]);
    assert.equal(await page.evaluate(`(() => {
      const records = [...nodeRecords.values()];
      return records.flatMap((a, i) => records.slice(i + 1).filter(b =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)).length;
    })()`), 0);
    const saved = await page.evaluate('JSON.parse(localStorage.getItem(sizesKey)).q1');
    assert.deepEqual(saved, { width: 690, height: 520 });
    const beforeReload = await page.evaluate('performance.timeOrigin');
    await page.go(url);
    await until(() => page.evaluate(`performance.timeOrigin !== ${beforeReload} && typeof currentSession !== 'undefined' && !!currentSession`), 'board reload');
    await prepare(page);
    await centerCard(page);
    assert.deepEqual((await page.evaluate(box)).slice(2, 4), [690, 520]);

    const reset = await handlePoint(page, 'n');
    await mouse(page, 'mousePressed', reset);
    await mouse(page, 'mouseReleased', reset);
    await mouse(page, 'mousePressed', reset, 2);
    await mouse(page, 'mouseReleased', reset, 2);
    assert.deepEqual(await page.evaluate(`[${node}.width, ${node}.height - ${automatic[3]}, JSON.parse(localStorage.getItem(sizesKey)).q1 ?? null]`),
      [300, 0, null]);
  });
});
