# Queue Notes

Original teaching example for a future Crowe Logic software film. The defect is intentional. No customer data, service, package installation or network access is involved. Do not describe this sample defect as a defect in Crowe Logic.

`summary(tasks)` accepts an array of task objects whose `state` is `todo`, `done` or `archived` and returns `{ active, completed, percent }`.

1. Archived tasks are outside the active set.
2. Completed tasks are active tasks whose state is `done`.
3. Percent is the completed fraction of active tasks, rounded to the nearest integer.
4. An empty active set returns zero for all three fields, including when every supplied task is archived.
5. Do not mutate the input array or its task objects.
6. Preserve the existing function export and return-field names. Arbitrary imported data validation is outside this example's scope.

Example: one `done` task and one `archived` task has one active task, one completed task and 100 percent, not 50 percent.

Run the six acceptance checks with `node --test summary.test.cjs`. The initial intentionally defective implementation fails four tests and passes two. No repaired implementation or fabricated assistant response is supplied. A future app demonstration must perform its own reviewed repair and retain its actual results.
