# Protocol size bounds, derived from the source on 2026-09-19

Facts read from `rooms/council.js` and `rooms/council-files.js` at dd65827, for
councils to cite rather than re-derive.

- `LIMIT` is 200000 characters. `canonical(before)` must be under `LIMIT` before
  a proposal is requested (`run()`, before the propose call).
- A goal is at most 4000 characters (`grant()`).
- A proposal summary is at most 8000 characters; `canonical(changes)` is at
  most `LIMIT`; each change content is at most 60000 characters; at most 12
  files (`normalize()`, `grant()`).
- A vote or verification reason is at most 4000 characters (`vote()`); a safety
  reason is sliced to 4000.
- The `previous` list sent to the proposer carries at most 10 summaries
  (`.slice(-10)`).
- Each selected file is at most 60000 bytes at snapshot, ordinary file, UTF-8
  (`rooms/council-files.js`, `target()` and `snapshot()`).
- A model response is rejected above `LIMIT` characters (`parse()`).

So the untrusted input per protocol call is bounded:

| Call | Input | Bound (characters, before JSON overhead) |
|---|---|---|
| propose | agreement, before, previous | 4000 + 200000 + 10 x 8000 |
| classify | agreement, before, proposal | 4000 + 200000 + 8000 + 200000 |
| vote | agreement, before, proposal, hash | 4000 + 200000 + 8000 + 200000 + 64 |
| verify | agreement, proposal, after, receipt | 4000 + 8000 + 200000 + 12 x 60000 + receipt |

The verify snapshot (`after`) is the one input `run()` does not re-check against
`LIMIT`; its bound comes only from the executor's per-file limit, so it can
exceed `LIMIT` (12 x 60000 = 720000).

Output is bounded only if the host sets a maximum output token count on the
request. Today `rooms/council-host.js` sets none: `d.chat` is called with
messages, tools `[]`, stream `false`, the abort signal and the model.
`scripts/council-run.js` likewise passes no output cap to `cli.headless`.
