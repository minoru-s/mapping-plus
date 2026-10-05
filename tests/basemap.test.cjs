const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function backgroundLayer(style = 'soft', saved = null, storageBlocked = false, config = {}) {
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
  const vectors = [];
  const timers = [];
  const makeLayer = (url, options, vector = false) => {
    requested = { url, options }; requests.push(requested);
    const listeners = new Map();
    const canvasListeners = new Map();
    const glCanvas = {
      addEventListener: (event, handler) => canvasListeners.set(event, handler),
      removeEventListener: event => canvasListeners.delete(event),
    };
    const gl = {
      loaded: false,
      on(event, handler) { listeners.set(event, handler); return this; },
      off(event) { listeners.delete(event); },
      getCanvas: () => glCanvas,
      isStyleLoaded() { return this.loaded; },
    };
    const layer = {
      on(event, handler) { handlers[event] = handler; return this; },
      addTo() {
        additions.push(this);
        if (vector && config.failVectorAdd) throw new Error('WebGL unavailable');
        return this;
      },
      getMaplibreMap: vector ? () => gl : undefined,
      getContainer: () => ({ remove() {} }),
    };
    if (vector) vectors.push({ layer, gl, listeners, canvasListeners });
    return layer;
  };
  const maplibreGL = options => makeLayer(options.style, options, true);
  const context = vm.createContext({
    L: { tileLayer: makeLayer },
    document: { getElementById: id => nodes[id] },
    window,
    fakeMap: { getPane: () => pane, removeLayer: layer => removals.push(layer),
      hasLayer: layer => additions.includes(layer) && !removals.includes(layer) },
    setTimeout(fn, ms) { const timer = { fn, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.active = false; },
    console: { warn() {}, error() {} },
    localStorage: {
      getItem(key) {
        if (storageBlocked) throw new Error('blocked');
        return key === 'mapping-plus-background-style-v2' ? saved : config.legacy ?? null;
      },
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
  context.vectorModule = { maplibreGL };
  vm.runInContext('vectorBasemapModulePromise = Promise.resolve(vectorModule)', context);
  vm.runInContext(`showToast = message => notices.push(message); map = fakeMap; createBackgroundLayer(${JSON.stringify(style)});`, context);
  return {
    get requested() { return requested; },
    context, requests, additions, removals, pane, nodes, window, placements, storageWrites, notices, vectors, timers,
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
  assert.deepEqual(layer.storageWrites, [{ key: 'mapping-plus-background-style-v2', value: 'gsi' }]);
  vm.runInContext("setBackgroundStyle('soft');", layer.context);
  assert.equal(state(), before);
  assert.equal(layer.nodes['basemap-hint'].hidden, true);
});

test('saved preference is validated and unavailable storage is harmless', () => {
  for (const [saved, expected] of [[null, 'liberty'], ['liberty', 'liberty'], ['positron', 'positron'], ['gsi', 'gsi'], ['soft', 'soft'], ['unknown', 'liberty'], ['toString', 'liberty']]) {
    const layer = backgroundLayer('soft', saved);
    assert.equal(vm.runInContext('readBackgroundStyle()', layer.context), expected);
  }
  const layer = backgroundLayer('soft', 'gsi', true);
  assert.equal(vm.runInContext('readBackgroundStyle()', layer.context), 'liberty');
  assert.doesNotThrow(() => vm.runInContext("setBackgroundStyle('gsi')", layer.context));
  const count = layer.requests.length;
  vm.runInContext("setBackgroundStyle('unknown')", layer.context);
  assert.equal(layer.requests.length, count);
});

test('previous standard moves to Liberty while an explicit GSI choice is retained', () => {
  for (const [legacy, expected] of [['soft', 'liberty'], ['gsi', 'gsi'], ['unknown', 'liberty']]) {
    const layer = backgroundLayer('soft', null, false, { legacy });
    assert.equal(vm.runInContext('readBackgroundStyle()', layer.context), expected);
  }
  const layer = backgroundLayer('soft', 'positron', false, { legacy: 'gsi' });
  assert.equal(vm.runInContext('readBackgroundStyle()', layer.context), 'positron');
});

test('Liberty is low contrast without desaturation and Positron resets the background filter', async () => {
  const layer = backgroundLayer();
  await vm.runInContext("setBackgroundStyle('liberty')", layer.context);
  assert.equal(layer.requested.url, 'https://tiles.openfreemap.org/styles/liberty');
  assert.equal(layer.pane.style.filter, 'contrast(0.65) brightness(1.18)');
  assert.doesNotMatch(layer.pane.style.filter, /saturate/);
  assert.equal(layer.requested.options.pane, 'tilePane');
  assert.equal(layer.requested.options.interactive, false);
  assert.match(layer.requested.options.attributionControl.customAttribution, /OpenMapTiles/);
  assert.match(layer.requested.options.attributionControl.customAttribution, /openstreetmap.org\/copyright/);
  await vm.runInContext("setBackgroundStyle('positron')", layer.context);
  assert.equal(layer.requested.url, 'https://tiles.openfreemap.org/styles/positron');
  assert.equal(layer.pane.style.filter, '');
  assert.equal(layer.nodes['basemap-select'].value, 'positron');
  assert.equal(layer.vectors[0].listeners.size, 0); // 古い監視・タイマーを解除
  assert.equal(layer.timers[0].active, false);
});

test('rapid selection cannot let an old asynchronous vector request replace the latest map', async () => {
  const layer = backgroundLayer();
  let resolveModule;
  layer.context.pendingModule = new Promise(resolve => { resolveModule = resolve; });
  vm.runInContext('vectorBasemapModulePromise = pendingModule', layer.context);
  const earlier = vm.runInContext("setBackgroundStyle('liberty')", layer.context);
  await vm.runInContext("setBackgroundStyle('gsi')", layer.context);
  resolveModule(layer.context.vectorModule);
  await earlier;
  assert.equal(layer.nodes['basemap-select'].value, 'gsi');
  assert.equal(layer.requested.url, 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png');
  assert.equal(layer.vectors.length, 0);
});

test('WebGL failure falls back without touching edit state or the saved vector preference', async () => {
  const layer = backgroundLayer('soft', null, false, { failVectorAdd: true });
  vm.runInContext("deletedCells.set('1,2', {val: 5}); undoStack.push({cells: 1}); sourceFileBytes = new Uint8Array([1,2,3]);", layer.context);
  const state = () => vm.runInContext('JSON.stringify({deleted: [...deletedCells], undo: undoStack, source: [...sourceFileBytes]})', layer.context);
  const before = state();
  await vm.runInContext("setBackgroundStyle('liberty')", layer.context);
  assert.equal(state(), before);
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  assert.deepEqual(layer.storageWrites, [{ key: 'mapping-plus-background-style-v2', value: 'liberty' }]);
  assert.match(layer.notices[0], /GPSデータは変更されません/);
});

test('vector load timeout falls back, while a partial tile error after load does not', async () => {
  const layer = backgroundLayer();
  await vm.runInContext("setBackgroundStyle('liberty')", layer.context);
  const timeout = layer.timers.find(timer => timer.active);
  assert.equal(timeout.ms, 20000);
  timeout.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  assert.equal(layer.notices.length, 1);

  await vm.runInContext("setBackgroundStyle('positron')", layer.context);
  const current = layer.vectors.at(-1);
  current.gl.loaded = true;
  current.listeners.get('load')();
  current.listeners.get('error')({ error: new Error('one missing tile') });
  assert.equal(layer.timers.at(-1).active, false);
  assert.equal(layer.nodes['basemap-select'].value, 'positron');
  assert.equal(layer.notices.length, 1);
});

test('context loss falls back and an old removed vector layer cannot affect the active map', async () => {
  const layer = backgroundLayer();
  await vm.runInContext("setBackgroundStyle('liberty')", layer.context);
  const oldCallback = layer.vectors[0].canvasListeners.get('webglcontextlost');
  await vm.runInContext("setBackgroundStyle('positron')", layer.context);
  oldCallback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(layer.nodes['basemap-select'].value, 'positron');
  layer.vectors[1].canvasListeners.get('webglcontextlost')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  assert.equal(layer.notices.length, 1);
});

test('a stalled or rejected library load falls back without saving the temporary fallback', async () => {
  const layer = backgroundLayer();
  let resolveModule;
  layer.context.pendingModule = new Promise(resolve => { resolveModule = resolve; });
  vm.runInContext('vectorBasemapModulePromise = pendingModule', layer.context);
  const pending = vm.runInContext("setBackgroundStyle('liberty')", layer.context);
  layer.timers.find(timer => timer.active).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  resolveModule(layer.context.vectorModule);
  await pending;
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  assert.equal(layer.vectors.length, 0);
  assert.deepEqual(layer.storageWrites, [{ key: 'mapping-plus-background-style-v2', value: 'liberty' }]);

  layer.context.failedModule = Promise.reject(new Error('CDN unavailable'));
  vm.runInContext('vectorBasemapModulePromise = failedModule', layer.context);
  await vm.runInContext("setBackgroundStyle('positron')", layer.context);
  assert.equal(layer.nodes['basemap-select'].value, 'soft');
  assert.equal(layer.notices.length, 2);
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
