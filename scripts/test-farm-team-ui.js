#!/usr/bin/env node
'use strict';

// Container lifecycle only; child modules and DOM are synthetic. No transport,
// account access, archive writes or Electron profile is used by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let document;
class Element {
  constructor(tag) { this.tagName = tag; this.ownerDocument = document; this.childNodes = []; this.dataset = {}; this.listeners = {}; this.hidden = false; }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.childNodes = [...children]; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { this.listeners.click?.(); }
  remove() { this.removed = true; }
}
document = { createElement: tag => new Element(tag) };
const container = new Element('main');
let changed;
const imports = [], hours = [], knowledge = [];
const stub = list => ({ mount(_panel, _api, options) {
  const state = { options, destroyed: false, opened: 0, deactivated: 0 };
  list.push(state);
  return { open() { state.opened++; }, deactivate() { state.deactivated++; }, destroy() { state.destroyed = true; } };
} });
const window = {
  FarmMessenger: { mount(_panel, _api, options) { changed = options.onFarmChanged; return { open() {}, deactivate() {}, destroy() {} }; } },
  FarmImports: stub(imports), FarmWorkforce: stub(hours), FarmAwareness: stub(knowledge),
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/farm-team.js'), 'utf8'), { window });
const instance = window.FarmTeam.mount(container, {}, {});
const shell = container.childNodes[0], nav = shell.childNodes[0];
const panel = key => shell.childNodes.find(node => node.dataset.teamPanel === key);
const tab = key => nav.childNodes.find(node => node.dataset.teamTab === key).click();
const enter = () => panel('imports').childNodes.find(node => node.tagName === 'button').click();
const farmA = { farmId: 'farm-a', currentMemberId: 'member-a', role: 'owner' };
const farmB = { farmId: 'farm-b', currentMemberId: 'member-b', role: 'worker' };
const farmC = { farmId: 'farm-c', currentMemberId: 'member-c', role: 'manager' };

changed(farmA);
tab('imports');
assert.equal(imports.length, 0, 'Opening tab alone does not open local archive');
enter();
assert.equal(imports.length, 1);
assert.equal(imports[0].options.sharedFarm.farmId, farmA.farmId);
assert.notEqual(imports[0].options.sharedFarm, farmA, 'Selection is copied, not retained by reference');
tab('messages');
tab('imports');
assert.equal(imports.length, 1, 'Same farm retains the existing archive instance');
changed({ ...farmA });
assert.equal(imports[0].destroyed, false, 'Equivalent selection does not reset consent');
changed(farmB);
assert.equal(imports[0].destroyed, true, 'Farm change destroys destination-bound import instance');
assert.equal(imports.length, 1, 'New destination cannot silently open the archive');
assert.equal(panel('imports').childNodes.some(node => node.tagName === 'button'), true);
enter();
assert.equal(imports.length, 2);
assert.equal(imports[1].options.sharedFarm.farmId, farmB.farmId);
changed(farmA);
assert.equal(imports[1].destroyed, true, 'Switching back also invalidates prior consent');
enter();
changed(null);
assert.equal(imports[2].destroyed, true, 'Lost membership clears selected-farm import state');
assert.equal(imports.length, 3, 'No implicit remount after membership loss');
instance.deactivate();
changed(farmB);
assert.equal(panel('imports').childNodes.length, 0, 'Inactive container stays unmounted on scope change');
instance.open();
assert.equal(imports.length, 3);
enter();
tab('hours');
assert.equal(hours.length, 1);
tab('knowledge');
assert.equal(knowledge.length, 1);
changed(farmC);
assert.equal(hours[0].destroyed, true, 'Hours are destroyed with the prior scope');
assert.equal(knowledge[0].destroyed, true, 'Knowledge is destroyed with the prior scope');
assert.equal(imports[3].destroyed, true, 'Hidden import tab also clears prior consent');
assert.equal(knowledge[1].options.farmId, farmC.farmId, 'Active scoped tab remounts for new farm');
instance.destroy();
assert.equal(imports[3].destroyed, true, 'Account teardown destroys import child');
const count = imports.length;
changed(farmA);
assert.equal(imports.length, count, 'Late farm callback cannot revive destroyed container');
console.log('farm-team-ui: destination changes clear import consent; archive entry stays explicit; teardown ignores stale callbacks');
