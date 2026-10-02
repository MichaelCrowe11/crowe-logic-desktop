'use strict';
// End-to-end smoke: the real bin entry, a real HTTP gateway, a real workspace.
// Nothing injected. Verifies the process actually runs, streams, edits, and
// exits with the documented code.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const turns = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/gateway/catalog')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [] }));
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const n = turns.length;
    turns.push(JSON.parse(body));
    const payload = n === 0
      ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'written by the cli\n' }) } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
      : { content: 'Created out.txt.', tool_calls: [], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(0, () => {
  const port = server.address().port;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-smoke-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-smokehome-'));
  // spawn, not spawnSync: the gateway this test talks to is served by this same
  // process, and a synchronous child would block the loop that has to answer it.
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'crowe.js'),
    '--tier', 'edit', '--auto-approve', '--json', '--cwd', ws,
    'create out.txt',
  ], {
    env: { ...process.env, CROWE_HOME: home, CROWE_CONFIG: path.join(home, 'cli.json'),
           CROWE_TOKEN: 'smoke-token', CROWE_BASE_URL: `http://127.0.0.1:${port}`, CROWE_MODEL: 'smoke-model' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30000);

  child.on('close', (status) => {
    clearTimeout(timer);
    server.close();

    const problems = [];
    if (status !== 0) problems.push(`exit ${status}: ${stderr}`);
    const events = stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
    if (events.some((e) => e.bad)) problems.push('non-JSON line on stdout');
    if (!events.some((e) => e.type === 'tool_call' && e.name === 'write_file')) problems.push('no write_file tool_call');
    if (!fs.existsSync(path.join(ws, 'out.txt'))) problems.push('out.txt was not written');
    const journal = path.join(home, 'journal');
    if (!fs.existsSync(journal) || !fs.readdirSync(journal).length) problems.push('no journal written');
    if (!turns.length) problems.push('the gateway was never called');
    if (turns.length && !turns[0].tools) problems.push('the gateway was sent no tool list');

    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });

    if (problems.length) { console.log('SMOKE FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log(`smoke ok: ${events.length} events, ${turns.length} gateway turns, file written, journal written`);
  });
});
