'use strict';
// Exercise the actual signIn implementation with a real loopback callback.
// Token exchange and browser launch are fakes; no identity service is contacted.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = src.indexOf('let pendingSignIn = null;');
const end = src.indexOf('ipcMain.handle("crowe:auth:login"', start);
assert(start > 0 && end > start, 'signIn source boundaries');

(async () => {
  for (const scenario of ['success', 'rejected', 'network', 'storage']) {
    let authUrl, persisted = false, exchanged = false;
    const servers = [];
    const ctx = vm.createContext({
      URL, URLSearchParams, AbortSignal, crypto,
      b64url: buffer => buffer.toString('base64url'),
      CROWE_ID: 'https://identity.invalid', CROWE_ID_CLIENT: 'fixture',
      shell: { openExternal: url => { authUrl = new URL(url); } },
      http: { createServer: handler => {
        const server = http.createServer(handler);
        const listen = server.listen.bind(server);
        server.listen = (_port, host) => listen(0, host);
        servers.push(server); return server;
      } },
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      persistTokens: () => { if (scenario === 'storage') throw new Error('storage unavailable'); persisted = true; },
      currentUser: () => ({ email: 'fixture@example.invalid' }),
      fetch: async (_url, init) => {
        exchanged = true;
        assert(init.signal, 'exchange has a deadline');
        const body = new URLSearchParams(init.body);
        assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'), 'PKCE challenge matches verifier');
        if (scenario === 'network') throw new Error('network unavailable');
        return new Response(JSON.stringify(scenario === 'rejected' ? { error: 'invalid_grant' } : { access_token: 'noncredential-fixture' }), { status: scenario === 'rejected' ? 400 : 200 });
      },
    });
    try {
      vm.runInContext(src.slice(start, end) + '\nthis.login = signIn;', ctx);
      const pending = ctx.login();
      for (let i = 0; !authUrl && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert(authUrl, 'browser receives authorization URL');
      assert.equal(ctx.login(), pending, 'repeated click shares pending attempt');
      const callback = new URL(authUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'fixture-code');
      callback.searchParams.set('state', 'wrong-state');
      assert.equal((await fetch(callback)).status, 400, 'wrong state cannot cancel sign-in');
      assert.equal(exchanged, false, 'wrong state does not exchange a code');
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      const response = await fetch(callback);
      const text = await response.text();
      const result = await pending;
      if (scenario === 'success') {
        assert(persisted, 'tokens stored before successful callback');
        assert.equal(response.status, 200); assert(result.ok); assert(text.includes('You are signed in'));
      } else {
        assert.equal(response.status, 502); assert(result.error); assert(!text.includes('You are signed in'));
        assert.equal(persisted, false, 'failed sign-in does not persist');
      }
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(vm.runInContext('pendingSignIn', ctx), null, 'attempt clears after completion');
      console.log('PASS sign-in ' + scenario);
    } finally {
      for (const server of servers) { server.closeAllConnections(); server.close(); }
    }
  }
})().catch(error => { console.error('FAIL ' + error.message); process.exitCode = 1; });
