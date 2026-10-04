const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function backgroundLayer(style = 'soft', saved = null, storageBlocked = false) {
  const handlers = {};
  const notices = [];
  let now = 0;
  let requested;
  const requests = [];
  const additions = [];
  const removals = [];
  const pane = { style: {} };
  const nodes = { 'basemap-select': {}, 'basemap-hint': {}, 'basemap-control': { parentElement: null } };
  const placements = [];
  for (const id of ['basemap-toolbar-slot', 'basemap-menu-slot']) {
    nodes[id] = { appendChild(control) { control.parentElement = this; placements.push(id); } };
  }
  const window = { innerWidth: 1280 };
  const storageWrites = [];
  const context = vm.createContext({
    L: { tileLayer(url, options) {
      requested = { url, options }; requests.push(requested);
      return {
        on(event, handler) { handlers[event] = handler; return this; },
        addTo() { additions.push(this); return this; },
      };
    } },
    document: { getElementById: id => nodes[id] },
    window,
    fakeMap: { getPane: () => pane, removeLayer: layer => removals.push(layer) },
    localStorage: {
      getItem() { if (storageBlocked) throw new Error('blocked'); return saved; },
      setItem(key, value) { if (storageBlocked) throw new Error('blocked'); storageWrites.push({ key, value }); },
    },
    Date: { now: () => now },
  });
  // 初期化だけは実行しない。実際のアプリの関数をネットワークなしで検証する。
  const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const boot = 'init().catch(console.error);';
  assert.ok(source.trimEnd().endsWith(boot));
  vm.runInContext(source.slice(0, source.lastIndexOf(boot)), context);
  context.notices = notices;
  vm.runInContext(`showToast = message => notices.push(message); map = fakeMap; createBackgroundLayer(${JSON.stringify(style)});`, context);
  return {
    get requested() { return requested; },
    context, requests, additions, removals, pane, nodes, window, placements, storageWrites, notices,
    emit: event => handlers[event](), advance: ms => { now += ms; },
  };
}

test('one background selector moves into the toolbar menu at narrow widths', () => {
  const layer = backgroundLayer();
  vm.runInContext("setBackgroundStyle('gsi', false)", layer.context);
  const selector = layer.nodes['basemap-select'];
  const requestCount = layer.requests.length;
  const position = () => vm.runInContext('positionBackgroundControl()', layer.context);
  position();
  assert.equal(layer.nodes['basemap-control'].parentElement, layer.nodes['basemap-toolbar-slot']);
  for (const width of [1200, 1000, 900, 720, 560, 390]) {
    layer.window.innerWidth = width;
    position();
    assert.equal(layer.nodes['basemap-control'].parentElement, layer.nodes['basemap-menu-slot']);
    assert.equal(layer.nodes['basemap-select'], selector);
    assert.equal(selector.value, 'gsi');
  }
  assert.deepEqual(layer.placements, ['basemap-toolbar-slot', 'basemap-menu-slot']);
  layer.window.innerWidth = 1201;
  position();
  assert.equal(layer.nodes['basemap-control'].parentElement, layer.nodes['basemap-toolbar-slot']);
  assert.equal(layer.requests.length, requestCount); // 配置変更だけでは地図を再取得しない
});

test('GSI pale tiles use the supported native zoom range and source attribution', () => {
  const { requested } = backgroundLayer('gsi');
  assert.equal(requested.url, 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png');
  assert.equal(requested.options.minNativeZoom, 2);
  assert.equal(requested.options.maxNativeZoom, 18);
  assert.equal(requested.options.maxZoom, 20);
  assert.match(requested.options.attribution, /maps.gsi.go.jp/);
  assert.match(requested.options.attribution, /VMAP0/);
});

test('background switching only replaces tiles and preserves edits and GPS data', () => {
  const layer = backgroundLayer();
  vm.runInContext(`
    deletedCells.set('100,200', { val: 3 });
    undoStack.push({ cells: 1 }); redoStack.push({ cells: 2 });
    sourceFileBytes = new Uint8Array([1, 2, 3]); eraserActive = true;
    setBackgroundStyle('soft', false);
  `, layer.context);
  const state = () => vm.runInContext(`JSON.stringify({
    deleted: [...deletedCells], undo: undoStack, redo: redoStack,
    source: [...sourceFileBytes], eraserActive,
  })`, layer.context);
  const before = state();
  assert.equal(layer.pane.style.filter, 'saturate(0.25) contrast(0.65) brightness(1.22)');
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  assert.equal(layer.nodes['basemap-hint'].hidden, true);
  vm.runInContext("setBackgroundStyle('gsi');", layer.context);
  assert.equal(state(), before);
  assert.equal(layer.pane.style.filter, '');
  assert.equal(layer.nodes['basemap-select'].value, 'gsi');
  assert.equal(layer.nodes['basemap-hint'].hidden, false);
  assert.equal(layer.removals[0], layer.additions[0]);
  assert.equal(layer.additions.length, 2);
  assert.deepEqual(layer.storageWrites, [{ key: 'mapping-plus-background-style', value: 'gsi' }]);
  vm.runInContext("setBackgroundStyle('soft');", layer.context);
  assert.equal(state(), before);
  assert.equal(layer.nodes['basemap-hint'].hidden, true);
});

test('saved preference is validated and unavailable storage is harmless', () => {
  for (const [saved, expected] of [[null, 'soft'], ['gsi', 'gsi'], ['soft', 'soft'], ['unknown', 'soft'], ['toString', 'soft']]) {
    const layer = backgroundLayer('soft', saved);
    assert.equal(vm.runInContext('readBackgroundStyle()', layer.context), expected);
  }
  const layer = backgroundLayer('soft', 'gsi', true);
  assert.equal(vm.runInContext('readBackgroundStyle()', layer.context), 'soft');
  assert.doesNotThrow(() => vm.runInContext("setBackgroundStyle('gsi')", layer.context));
  const count = layer.requests.length;
  vm.runInContext("setBackgroundStyle('unknown')", layer.context);
  assert.equal(layer.requests.length, count);
});

test('keyless standard tiles, attribution, and native zoom ceiling', () => {
  const { requested } = backgroundLayer();
  assert.equal(requested.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(requested.options.maxNativeZoom, 19);
  assert.equal(requested.options.maxZoom, 20);
  assert.equal(requested.options.keepBuffer, 1);
  assert.match(requested.options.attribution, /openstreetmap.org\/copyright/);
  assert.match(requested.options.attribution, /contributors/);
  assert.equal(requested.options.subdomains, undefined);
});

test('a fully failed tile batch explains that GPS data is unchanged', () => {
  const layer = backgroundLayer();
  layer.emit('loading');
  layer.emit('tileerror');
  layer.emit('load');
  assert.equal(layer.notices.length, 1);
  assert.match(layer.notices[0], /背景地図/);
  assert.match(layer.notices[0], /GPSデータは変更されません/);
});

test('successful and partially successful batches do not show a warning', () => {
  const layer = backgroundLayer();
  layer.emit('loading');
  layer.emit('tileload');
  layer.emit('tileerror');
  layer.emit('load');
  assert.equal(layer.notices.length, 0);
  layer.emit('loading');
  layer.emit('tileload');
  layer.emit('load');
  assert.equal(layer.notices.length, 0);
});

test('repeat failures are throttled and tile counters reset for the next batch', () => {
  const layer = backgroundLayer();
  const fail = () => {
    layer.emit('loading'); layer.emit('tileerror'); layer.emit('load');
  };
  fail();
  fail();
  assert.equal(layer.notices.length, 1);
  layer.emit('loading'); layer.emit('tileload'); layer.emit('load');
  layer.advance(31000);
  fail();
  assert.equal(layer.notices.length, 2);
});
