import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBlock } from './load-block.mjs';
import { browserTest, withBoard } from './headless-board.mjs';

const questions = Array.from({ length: 2000 }, (_, index) => ({
  id: 'q' + index, title: 'Decision ' + index, status: 'settled',
  dependsOn: index ? ['q' + (index - 1)] : [], decision: 'Settled'
}));
const constants = { ideaWidth: 380, gapX: 28, gapY: 64, lrGapX: 96, lrGapY: 28 };
const nodes = [{ id: '@idea', kind: 'idea', width: 380, height: 80 },
  ...questions.map(question => ({ id: question.id, kind: 'question', width: 300, height: 100, validDependencies: question.dependsOn }))];

for (const flow of ['td', 'lr']) test('cold ' + flow + ' layout places the end of a 2,000-question chain', () => {
  const result = loadBlock('grill-layout', 'GrillLayout').layout({ nodes, flow, constants });
  assert.deepEqual(result.positions.q1999, flow === 'td' ? { x: -150, y: 327980 } : { x: 792080, y: -50 });
  assert.equal(result.parents.q1999, 'q1998');
  assert.equal(result.levels.length, 2001);
});

browserTest('the real board renders and updates a 2,000-question chain', async () => {
  await withBoard({ questions }, async ({ page, session }) => {
    assert.equal(await page.evaluate('graph && Object.keys(graph.positions).length'), 2001);
    assert.equal(await page.evaluate('graph.parents.q1999'), 'q1998');
    assert.equal(await page.evaluate('document.querySelectorAll(".question-card").length'), 2000);
    await session({ title: 'Updated deep board', questions });
    assert.equal(await page.evaluate('header.querySelector("h1").textContent'), 'Updated deep board');
    assert.equal(await page.evaluate('graph.parents.q1999'), 'q1998');
  });
});
