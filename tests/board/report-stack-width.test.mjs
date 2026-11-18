import assert from 'node:assert/strict';
import { browserTest as test, withBoard } from './headless-board.mjs';
import { loadBlock } from './load-block.mjs';

const data = { lang: 'en', questions: [
  { id: 'q1', title: 'First', status: 'settled', decision: 'First decision' },
  { id: 'q2', title: 'Second', status: 'asking', options: Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: 'Option ' + i })) }
], research: [{ id: 's1', target: 'q1', topic: 'Research', status: 'done', report: 's1.md' }] };

test('widening a report leaves its reserved stack width and sibling position unchanged', async () => {
  await withBoard(data, async ({ page }) => {
    assert.deepEqual(await page.evaluate(`(() => {
      flow = 'td'; document.documentElement.dataset.flow = flow; measureAndLayout();
      const handle = nodeRecords.get('report:s1').element.resizeHandle;
      const before = nodeRecords.get('q2').x;
      for (let i = 0; i < 24; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      const report = nodeRecords.get('report:s1'), other = nodeRecords.get('q2');
      const width = Math.max(0, Math.min(report.x + report.width, other.x + other.width) - Math.max(report.x, other.x));
      const height = Math.max(0, Math.min(report.y + report.height, other.y + other.height) - Math.max(report.y, other.y));
      return { reportWidth: report.width, clusterWidth: graph.clusters.find(c => c.id === 'q1').width,
        siblingX: [before, other.x], overlap: width * height > 0 };
    })()`), { reportWidth: 720, clusterWidth: 300, siblingX: [14, 14], overlap: true });
    const cluster = loadBlock('grill-layout', 'GrillLayout').cluster({ flow: 'td',
      node: { id: 'q1', width: 300, height: 80 }, refs: [{ id: 'r1', width: 200, height: 80 }],
      reports: [{ id: 's1', width: 720, height: 80 }] });
    assert.equal(cluster.width, 944);
    assert.deepEqual(cluster.positions.r1, { x: 744, y: 0 });
  });
});
