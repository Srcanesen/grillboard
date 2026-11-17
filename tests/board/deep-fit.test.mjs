import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBlock } from './load-block.mjs';
import { browserTest, withBoard } from './headless-board.mjs';

const screen = { width: 1200, height: 800, boardHidden: false, header: { right: 400, bottom: 120 },
  toolbar: { right: 300, top: 740 }, roundBar: null, specPanel: null };
for (const flow of ['td', 'lr']) test('Fit contains a 100-level tree in ' + flow, () => {
  const boxes = Array.from({ length: 100 }, (_, i) => ({ x: flow === 'lr' ? i * 396 : 0,
    y: flow === 'td' ? i * 164 : 0, width: 300, height: 100 }));
  const target = loadBlock('grill-camera', 'GrillCamera').fit(boxes, screen);
  const visible = boxes.every(box => box.x * target.z + target.x >= 0 && box.y * target.z + target.y >= 0 &&
    (box.x + box.width) * target.z + target.x <= screen.width && (box.y + box.height) * target.z + target.y <= screen.height);
  assert.equal(visible, true);
  assert.equal(target.z > 0 && target.z < .1, true);
});

browserTest('the first manual zoom step from a fitted scale below ten percent returns to ten percent', async () => {
  await withBoard({ questions: Array.from({ length: 100 }, (_, i) => ({ id: 'q' + i,
    status: 'settled', title: 'Decision', decision: 'Settled', dependsOn: i ? ['q' + (i - 1)] : [] })) }, async ({ page }) => {
    for (const action of ["toolbar.querySelectorAll('button')[0].click()", "toolbar.querySelectorAll('button')[1].click()",
      "canvas.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, clientX: 400, clientY: 300, cancelable: true }))",
      `pointers.set(1, { x: 400, y: 300, type: 'touch' }); pointers.set(2, { x: 500, y: 300, type: 'touch' });
       pinch = { zoom: view.z, point: worldPoint(450, 300), distance: 100 };
       canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 510, clientY: 300 }));
       pinch = null; pointers.clear();`]) {
      assert.deepEqual(await page.evaluate(`(() => {
        fitToScreen(false); const fitted = view.z; ${action};
        return { belowTenPercent: fitted < .1, manualZoom: view.z };
      })()`), { belowTenPercent: true, manualZoom: .1 });
    }
  });
});
