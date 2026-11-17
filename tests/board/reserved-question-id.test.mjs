import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadBlock } from './load-block.mjs';

const loader = new URL('./load-block.mjs', import.meta.url).href;
test('reserved and duplicate question ids cannot replace the idea or stall layout', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadBlock } from ${JSON.stringify(loader)};
    const result = loadBlock('grill-layout', 'GrillLayout').layout({ flow: 'td',
      constants: { ideaWidth: 380, gapX: 28, gapY: 64, lrGapX: 96, lrGapY: 28 },
      nodes: [{ id: '@idea', kind: 'idea', width: 380, height: 80 },
        { id: '@idea', kind: 'question', width: 300, height: 100 },
        { id: 'q1', kind: 'question', width: 300, height: 100 },
        { id: 'q1', kind: 'question', width: 300, height: 100, validDependencies: ['q1'] }] });
    console.log(JSON.stringify({ ids: result.clusters.map(c => c.id), parent: result.parents.q1 }));
  `], { encoding: 'utf8', timeout: 1000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { ids: ['@idea', 'q1'], parent: '@idea' });
  const model = loadBlock('grill-session', 'GrillSession').model({ questions: [
    { id: '@idea' }, { id: 'ref:user:u1' }, { id: 'ref:agent:r1' }, { id: 'research:s1' },
    { id: 'report:s1' }, { id: 'sketch:k1' }, { id: 'q1' }, { id: 'q1' }
  ] });
  assert.deepEqual(model.questions.map(q => q.id), ['q1']);
});
