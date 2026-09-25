'use strict';

// Intentionally defective teaching example, not production application code.
function summary(tasks) {
  const active = tasks.length;
  const completed = tasks.filter(task => task.state === 'done').length;
  return { active, completed, percent: Math.round(completed / active * 100) };
}

module.exports = { summary };
