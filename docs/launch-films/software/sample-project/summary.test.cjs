'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { summary } = require('./summary.cjs');

test('archived tasks do not lower completion', () => {
  assert.deepEqual(summary([{ state: 'done' }, { state: 'archived' }]),
    { active: 1, completed: 1, percent: 100 });
});
test('partially completed active work is counted', () => {
  assert.deepEqual(summary([{ state: 'done' }, { state: 'todo' }]),
    { active: 2, completed: 1, percent: 50 });
});
test('empty input has an intentional zero summary', () => {
  assert.deepEqual(summary([]), { active: 0, completed: 0, percent: 0 });
});
test('all-archived input has an empty active set', () => {
  assert.deepEqual(summary([{ state: 'archived' }]), { active: 0, completed: 0, percent: 0 });
});
test('percentage is rounded within the active set', () => {
  assert.deepEqual(summary([{ state: 'done' }, { state: 'todo' }, { state: 'todo' }, { state: 'archived' }]),
    { active: 3, completed: 1, percent: 33 });
});
test('input array and task objects are unchanged', () => {
  const tasks = [{ state: 'done' }, { state: 'archived' }];
  const before = structuredClone(tasks);
  summary(tasks);
  assert.deepEqual(tasks, before);
});
