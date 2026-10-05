// Browser checks for the general-purpose mobile product and upgrade preservation.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '../mobile/www');
let server;
app.whenReady().then(async () => {
  let code = 0;
  try {
    server = http.createServer((req, res) => {
      const file = path.join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
      fs.readFile(file, (error, data) => {
        if (error) return res.writeHead(404).end();
        const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)];
        res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }); res.end(data);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: 'product-reset-test' } });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const run = script => win.webContents.executeJavaScript(script);
    const wait = () => new Promise(resolve => setTimeout(resolve, 1800));
    await win.loadURL(url); await wait();
    await run(`localStorage.setItem('crowe-spaces', JSON.stringify(['chat','cultivation'])); localStorage.setItem('crowe-space','cultivation'); localStorage.setItem('crowe:grow:blocks',JSON.stringify([{id:'preserve-me',code:'DEMO'}]));`);
    await win.loadURL(url); await wait();
    assert.equal(await run(`document.body.dataset.pane`), 'home');
    assert.equal(await run(`document.querySelector('#m-home-pane .m-h-title').textContent`), 'What are we working on?');
    // The prerequisite is on screen, not folded into a disclosure.
    assert.equal(await run(`[...document.querySelectorAll('#m-home-pane .m-h-status span')].some(e => e.checkVisibility() && /awake/.test(e.textContent) && /Tailscale/.test(e.textContent))`), true);
    assert.equal(await run(`!!document.getElementById('m-home-mode')`), false, 'unpaired Home names no operating mode');
    assert.equal(await run(`document.querySelector('#spaces [data-space="cultivation"]').checkVisibility()`), false);
    assert.equal(await run(`document.querySelector('#m-tabs').textContent.includes('Log')`), false);
    assert.equal(await run(`JSON.parse(localStorage.getItem('crowe:grow:blocks'))[0].id`), 'preserve-me');
    console.log('PASS: upgraded install starts on task Home; cultivation navigation hidden; original records preserved');
    for (let i = 0; i < 3; i++) {
      await run(`document.querySelector('#m-tabs [data-id="home"]').click()`); await wait();
      await run(`document.querySelectorAll('[data-task]')[${i}].click()`); await wait();
      assert.equal(await run(`document.body.dataset.pane`), 'agent');
      assert.ok((await run(`document.getElementById('input').value`)).length > 20);
    }
    console.log('PASS: all three task cards open Chat with editable requests, without sending');
    await run(`document.querySelector('#m-tabs [data-id="home"]').click()`); await wait();
    await run(`document.getElementById('m-home-pair').click()`); await wait();
    assert.equal(await run(`document.getElementById('settings').checkVisibility()`), true);
    assert.equal(await run(`!!document.querySelector('#cfg-spaces [data-space="cultivation"]')`), false);
    assert.equal(await run(`document.getElementById('m-founders-open').checkVisibility()`), false);
    await run(`document.getElementById('cfg-cancel').click()`); await wait();
    assert.equal(await run(`document.getElementById('sense-state').checkVisibility()`), false);
    assert.equal(await run(`Array.from(document.querySelectorAll('[aria-label]')).some(e => e.getAttribute('aria-label') === 'Photograph a block, bag or plate')`), false);
    console.log('PASS: pairing opens settings; farm space, sensor setup, and founders promotion are absent');
    // Paired: Home names the operating mode in plain words, follows a change,
    // never implies per-action approval, and the mode picker is on screen.
    await run(`document.body.classList.add('m-paired'); document.body.dataset.tier = 'edit'; document.querySelector('#m-tabs [data-id="chat"]').click()`); await wait();
    assert.equal(await run(`document.getElementById('autonomy').checkVisibility()`), true, 'mode picker visible when paired');
    await run(`document.querySelector('#m-tabs [data-id="home"]').click()`); await wait();
    assert.match(await run(`document.getElementById('m-home-mode').textContent`), /Edit.*Commands need Execute/);
    await run(`document.body.dataset.tier = 'readonly'`); await wait();
    const mode = await run(`document.getElementById('m-home-mode').textContent`);
    assert.match(mode, /Read.*Changes nothing/);
    assert.doesNotMatch(mode, /approve|each action|every action/i);
    await run(`document.body.classList.remove('m-paired')`);
    console.log('PASS: paired Home states the operating mode, follows changes, and the picker is visible');
    for (const width of [390, 430]) {
      win.setContentSize(width, 844); await wait();
      assert.equal(await run(`document.documentElement.scrollWidth <= innerWidth`), true);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.resolve(__dirname, `../mobile/scratch-1.1/product-home-${width}.png`), image.toPNG());
    }
    console.log('PASS: phone widths fit without horizontal overflow; screenshots captured');
  } catch (error) { console.error(error); code = 1; }
  finally { if (server) server.close(); app.exit(code); }
});
