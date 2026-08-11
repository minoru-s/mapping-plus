'use strict';

// ========================= 定数 =========================

const HEADER_LEN = 24; // 'MyAllTracksBackup.v0001:'
const K = 5000;         // zoom16基準: lat_deg = internal / K - 90
const MIN_EDIT_ZOOM = 10;
const CELL_ALPHA = 0.72;
const CELL_POPUP_RADIUS = 16;
const CELL_POPUP_ARROW_WIDTH = 20;
const CELL_POPUP_ARROW_HEIGHT = 10;
const EARTH_RADIUS_M = 6371008.8;
const RANKING_LIMIT = 30;

// マップズーム → アプリ内ズームレベル（低いほどタイルが少ない）
function getAppZoom(mapZoom) {
  if (mapZoom >= 15) return 16;
  if (mapZoom >= 13) return 14;
  if (mapZoom >= 11) return 12;
  if (mapZoom >= 9)  return 10;
  if (mapZoom >= 7)  return 8;
  if (mapZoom >= 5)  return 6;
  return 4;
}

// 各アプリズームでの変換係数
// zoom16: Kz=5000, zoom14: Kz=1250, zoom8: Kz≈19.5, ...
function getKz(appZoom) {
  return K / Math.pow(2, 16 - appZoom);
}

// ========================= 状態 =========================

let SQL = null;
let innerZip = null;
let tileCache = new Map();    // 'appZoom_A_B' -> [{lat_i, lng_i, val}]
let loadingTasks = new Map(); // 同じタイルの並行読込は同一 Promise を共有
let totalCells = 0;
let map = null;
let canvas = null;
let ctx = null;
let updateTimer = null;
let updateGeneration = 0;     // 古い非同期更新の再描画を無効化
let isZooming = false;
let sourceFileBytes = null;
let sourceFileName = '';
let eraserActive = false;
let deletedCells = new Map(); // zoom16 の "lat,lng" -> 元レコード
let deletionDeltas = new Map(); // zoom -> Map("lat,lng" -> 集約削除量)
let undoStack = [];
let redoStack = [];
let activeStroke = null;
let brushQueue = Promise.resolve();
let toastTimer = null;
let lastModalTrigger = null;
let cellInfoRequestId = 0;
let cellPopupLatLng = null;
let dateFilterStart = null;
let dateFilterEndExclusive = null;
let zoom16Cells = [];
let insightsReady = false;
let insightsLoading = false;
let insightsGeneration = 0;
let insightsUpdateTimer = null;
let municipalityBoundariesPromise = null;
let municipalityLocationCache = new Map();
let rankingLocationGeneration = 0;
let rankingPanSync = null;
let mergeFiles = [null, null];
let mergeSources = [null, null];
let mergeAnalysis = null;
let mergeBusy = false;
let mergePreviewActive = false;
let mergePreviewCanvas = null;
let mergePreviewCtx = null;
let mergePreviewFrame = null;

const CURRENT_VERSION = '1.3.0';
const UPDATE_SEEN_KEY = `mapping-plus-update-seen-${CURRENT_VERSION}`;

// ========================= XOR 復号 =========================

function xorDecrypt(buf) {
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x55;
  return out;
}

// ========================= UI =========================

const $ = id => document.getElementById(id);
function setStatus(text) { $('status-text').textContent = text; }
function setProgress(pct) { $('progress-fill').style.width = `${Math.min(100, pct)}%`; }
function updateCount() {
  const count = insightsReady ? zoom16Cells.length : totalCells;
  $('point-count').textContent = count > 0
    ? `${count.toLocaleString()} cells 読込済` : '';
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setToolbarMenuOpen(open) {
  const menu = $('toolbar-overflow-menu');
  const button = $('toolbar-menu-btn');
  if (!menu || !button) return;
  menu.classList.toggle('hidden', !open);
  button.classList.toggle('active', open);
  button.setAttribute('aria-expanded', String(open));
}

function setUpdateBadgeVisible(visible) {
  document.querySelectorAll('[data-modal-target="about"]').forEach(button => {
    button.classList.toggle('has-update-badge', visible);
    button.setAttribute(
      'aria-label',
      visible ? 'このツールについて（更新情報あり）' : 'このツールについて'
    );
  });
}

function initUpdateBadge() {
  let seen = false;
  try {
    seen = localStorage.getItem(UPDATE_SEEN_KEY) === 'seen';
  } catch (_) {
    // localStorageを利用できない環境では、ページを開いている間だけ既読状態を保つ。
  }
  setUpdateBadgeVisible(!seen);
}

function markUpdateSeen() {
  setUpdateBadgeVisible(false);
  try {
    localStorage.setItem(UPDATE_SEEN_KEY, 'seen');
  } catch (_) {
    // 表示中のページではバッジを消したままにする。
  }
}

function openMergeModal(trigger) {
  if (!sourceFileBytes) return;
  setToolbarMenuOpen(false);
  if (deletedCells.size > 0) {
    showToast('マージする前に、現在の編集内容を保存してください');
    return;
  }
  const currentFile = new File(
    [sourceFileBytes],
    sourceFileName || 'current.mapping',
    { type: 'application/octet-stream' }
  );
  mergeFiles = [currentFile, null];
  mergeSources = [null, null];
  mergeAnalysis = null;
  $('merge-file-a-name').textContent = currentFile.name;
  $('merge-file-b-name').textContent = '未選択';
  $('merge-file-b').value = '';
  $('merge-analyze').disabled = true;
  $('merge-progress').classList.add('hidden');
  $('merge-result').classList.add('hidden');
  openInfoModal('merge', trigger);
}

function openInfoModal(name, trigger = null) {
  const content = $(`modal-${name}`);
  if (!content) return;
  if (name === 'about') markUpdateSeen();
  lastModalTrigger = trigger;
  document.querySelectorAll('.modal-content').forEach(section => {
    section.classList.toggle('hidden', section !== content);
  });
  $('modal-title').textContent = content.dataset.title;
  $('modal-backdrop').classList.remove('hidden');
  $('modal-body').scrollTop = 0;
  $('modal-close').focus();
}

function closeInfoModal() {
  if ($('modal-backdrop').classList.contains('hidden')) return;
  $('modal-backdrop').classList.add('hidden');
  if (lastModalTrigger?.isConnected) lastModalTrigger.focus();
  lastModalTrigger = null;
}

function currentAppZoom() {
  return map ? getAppZoom(map.getZoom()) : 4;
}

function isDateFilterActive() {
  return dateFilterStart !== null || dateFilterEndExclusive !== null;
}

function dateInputValue(timestamp) {
  if (timestamp === null) return '';
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function updateDateFilterUI() {
  const active = isDateFilterActive();
  const button = $('date-filter-btn');
  if (!button) return;
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  $('date-filter-state').textContent = active
    ? `${dateFilterStart === null ? '指定なし' : dateInputValue(dateFilterStart)} 〜 ${dateFilterEndExclusive === null ? '指定なし' : dateInputValue(dateFilterEndExclusive - 1)}`
    : 'すべての期間を表示中';
}

function updateEditUI() {
  const z = currentAppZoom();
  const filterActive = isDateFilterActive();
  const eraserBtn = $('eraser-btn');
  if (!eraserBtn) return;
  eraserBtn.classList.toggle('active', eraserActive);
  eraserBtn.classList.toggle('unavailable', z < MIN_EDIT_ZOOM || filterActive);
  eraserBtn.disabled = filterActive;
  eraserBtn.setAttribute('aria-pressed', String(eraserActive));
  eraserBtn.title = filterActive
    ? '期間絞り込み中は消しゴムを使用できません'
    : z < MIN_EDIT_ZOOM
      ? `編集するにはZoom ${MIN_EDIT_ZOOM}以上まで拡大してください`
      : '消しゴム（E）';
  const menuEraser = $('menu-eraser');
  if (menuEraser) {
    menuEraser.classList.toggle('active', eraserActive);
    menuEraser.disabled = filterActive;
    menuEraser.setAttribute('aria-pressed', String(eraserActive));
    menuEraser.title = eraserBtn.title;
  }
  $('undo-btn').disabled = undoStack.length === 0;
  $('redo-btn').disabled = redoStack.length === 0;
  $('save-btn').disabled = deletedCells.size === 0;
  const removedRecords = [...deletedCells.values()].reduce((sum, c) => sum + (c.val || 0), 0);
  const editSummary = filterActive
    ? '期間絞り込み中 · 消しゴム無効'
    : deletedCells.size
    ? `${deletedCells.size.toLocaleString()} cells · ${removedRecords.toLocaleString()} records 削除予定`
    : `編集なし · Zoom ${z}`;
  $('edit-summary').textContent = editSummary;
  $('edit-summary').title = editSummary;
  updateDateFilterUI();
  scheduleInsightsUpdate();
}

function setEraserActive(active) {
  if (active && isDateFilterActive()) {
    showToast('期間絞り込み中は消しゴムを使用できません');
    updateEditUI();
    return;
  }
  if (active && currentAppZoom() < MIN_EDIT_ZOOM) {
    showToast(`編集するにはZoom ${MIN_EDIT_ZOOM}以上まで拡大してください`);
    updateEditUI();
    return;
  }
  eraserActive = !!active;
  if (map) {
    if (eraserActive) closeCellInfo();
    if (eraserActive) map.dragging.disable();
    else map.dragging.enable();
  }
  if (canvas) canvas.style.pointerEvents = eraserActive ? 'auto' : 'none';
  if (!eraserActive) $('brush-cursor').style.display = 'none';
  updateEditUI();
}

function resetEdits() {
  cellInfoRequestId++;
  closeCellInfo();
  setEraserActive(false);
  deletedCells.clear();
  deletionDeltas.clear();
  undoStack = [];
  redoStack = [];
  activeStroke = null;
  brushQueue = Promise.resolve();
  dateFilterStart = null;
  dateFilterEndExclusive = null;
  const startInput = $('date-filter-start');
  const endInput = $('date-filter-end');
  if (startInput) startInput.value = '';
  if (endInput) endInput.value = '';
  $('date-filter-panel')?.classList.add('hidden');
  updateEditUI();
}

// ========================= ランキング・全体統計 =========================

function setInsightsPanelOpen(open) {
  const panel = $('insights-panel');
  const button = $('insights-btn');
  panel.classList.toggle('hidden', !open);
  button.setAttribute('aria-expanded', String(open));
  button.classList.toggle('active', open);
  if (open) {
    renderInsights();
    $('insights-close').focus();
  }
}

function resetInsights() {
  insightsGeneration++;
  rankingLocationGeneration++;
  clearTimeout(insightsUpdateTimer);
  zoom16Cells = [];
  insightsReady = false;
  insightsLoading = false;
  $('insights-btn').disabled = true;
  $('insights-loading').textContent = '訪問データを集計しています…';
  $('insights-loading').classList.remove('hidden');
  $('insights-content').classList.add('hidden');
  setInsightsPanelOpen(false);
}

function zoom16CellAreaKm2(lat_i) {
  const south = lat_i / K - 90;
  const north = (lat_i + 1) / K - 90;
  const deltaLng = Math.PI / 180 / K;
  const band = Math.abs(
    Math.sin(north * Math.PI / 180) - Math.sin(south * Math.PI / 180)
  );
  return EARTH_RADIUS_M * EARTH_RADIUS_M * deltaLng * band / 1_000_000;
}

function formatArea(areaKm2) {
  if (areaKm2 < 0.01) {
    return `${Math.round(areaKm2 * 1_000_000).toLocaleString()} m²`;
  }
  const maximumFractionDigits = areaKm2 >= 100 ? 1 : areaKm2 >= 1 ? 2 : 3;
  return `${areaKm2.toLocaleString('ja-JP', { maximumFractionDigits })} km²`;
}

function formatStatDate(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function nearestMunicipality(areaKm2) {
  const municipalities = window.MUNICIPALITY_AREAS || [];
  if (!(areaKm2 > 0) || municipalities.length === 0) return null;
  return municipalities.reduce((nearest, municipality) => {
    if (!nearest) return municipality;
    const distance = Math.abs(Math.log(areaKm2 / municipality.area));
    const nearestDistance = Math.abs(Math.log(areaKm2 / nearest.area));
    return distance < nearestDistance ? municipality : nearest;
  }, null);
}

function formatMunicipalityComparison(areaKm2) {
  const municipality = nearestMunicipality(areaKm2);
  if (!municipality) return '比較できるデータがありません';
  const ratio = areaKm2 / municipality.area;
  const place = `${municipality.pref}${municipality.name}`;
  if (ratio >= 0.98 && ratio <= 1.02) {
    return `${place}（${municipality.area.toLocaleString()} km²）とほぼ同じ広さ`;
  }
  const percent = ratio * 100;
  const digits = percent < 10 ? 1 : 0;
  return `${place}（${municipality.area.toLocaleString()} km²）の約${percent.toLocaleString('ja-JP', { maximumFractionDigits: digits })}%`;
}

async function loadMunicipalityBoundaries() {
  if (!municipalityBoundariesPromise) {
    municipalityBoundariesPromise = new Promise((resolve, reject) => {
      if (Array.isArray(window.MAPPING_PLUS_MUNICIPALITY_BOUNDARIES)) {
        resolve(window.MAPPING_PLUS_MUNICIPALITY_BOUNDARIES);
        return;
      }
      const script = document.createElement('script');
      script.src = 'data/municipality-boundaries.js';
      script.onload = () => {
        if (Array.isArray(window.MAPPING_PLUS_MUNICIPALITY_BOUNDARIES)) {
          resolve(window.MAPPING_PLUS_MUNICIPALITY_BOUNDARIES);
        } else {
          reject(new Error('自治体境界データの形式が正しくありません'));
        }
      };
      script.onerror = () => reject(new Error('自治体境界データを読み込めません'));
      document.head.appendChild(script);
    }).catch(error => {
      municipalityBoundariesPromise = null;
      throw error;
    });
  }
  return municipalityBoundariesPromise;
}

function decodeTopologyArcs(topology) {
  const [scaleX, scaleY] = topology.transform.scale;
  const [translateX, translateY] = topology.transform.translate;
  return topology.arcs.map(encodedArc => {
    let x = 0;
    let y = 0;
    const points = encodedArc.map(([deltaX, deltaY]) => {
      x += deltaX;
      y += deltaY;
      return [x * scaleX + translateX, y * scaleY + translateY];
    });
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [lng, lat] of points) {
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
    return { points, bbox: [west, south, east, north] };
  });
}

function collectArcIndexes(value, indexes) {
  if (typeof value === 'number') {
    indexes.push(value >= 0 ? value : ~value);
    return;
  }
  for (const child of value || []) collectArcIndexes(child, indexes);
}

function geometryBounds(geometry, decodedArcs) {
  const indexes = [];
  collectArcIndexes(geometry.arcs, indexes);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const index of indexes) {
    const bbox = decodedArcs[index]?.bbox;
    if (!bbox) continue;
    west = Math.min(west, bbox[0]);
    south = Math.min(south, bbox[1]);
    east = Math.max(east, bbox[2]);
    north = Math.max(north, bbox[3]);
  }
  return [west, south, east, north];
}

function pointInBounds(lng, lat, bounds) {
  return lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
}

function topologyRing(arcIndexes, decodedArcs) {
  const ring = [];
  for (const reference of arcIndexes) {
    const arc = decodedArcs[reference >= 0 ? reference : ~reference]?.points || [];
    const points = reference >= 0 ? arc : [...arc].reverse();
    ring.push(...(ring.length ? points.slice(1) : points));
  }
  return ring;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat) &&
      lng < (xj - xi) * (lat - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonArcs(lng, lat, polygonArcs, decodedArcs) {
  if (!polygonArcs?.length) return false;
  if (!pointInRing(lng, lat, topologyRing(polygonArcs[0], decodedArcs))) return false;
  for (let i = 1; i < polygonArcs.length; i++) {
    if (pointInRing(lng, lat, topologyRing(polygonArcs[i], decodedArcs))) return false;
  }
  return true;
}

function pointInTopologyGeometry(lng, lat, geometry, decodedArcs) {
  if (geometry.type === 'Polygon') {
    return pointInPolygonArcs(lng, lat, geometry.arcs, decodedArcs);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.arcs.some(polygon => pointInPolygonArcs(lng, lat, polygon, decodedArcs));
  }
  return false;
}

async function resolveMunicipalityLocations(cells) {
  const resolved = new Map();
  const pending = [];
  for (const cell of cells) {
    const key = rowKey(cell.lat_i, cell.lng_i);
    if (municipalityLocationCache.has(key)) {
      resolved.set(key, municipalityLocationCache.get(key));
      continue;
    }
    pending.push({
      key,
      lng: (cell.lng_i + 0.5) / K - 180,
      lat: (cell.lat_i + 0.5) / K - 90,
    });
  }
  if (pending.length === 0) return resolved;

  const topologies = await loadMunicipalityBoundaries();
  const unresolved = new Map(pending.map(point => [point.key, point]));
  for (const topology of topologies) {
    if (unresolved.size === 0) break;
    const object = Object.values(topology.objects)[0];
    const decodedArcs = decodeTopologyArcs(topology);
    const features = object.geometries.map(geometry => ({
      geometry,
      bounds: geometryBounds(geometry, decodedArcs),
    }));
    const topologyBounds = features.reduce((bounds, feature) => [
      Math.min(bounds[0], feature.bounds[0]),
      Math.min(bounds[1], feature.bounds[1]),
      Math.max(bounds[2], feature.bounds[2]),
      Math.max(bounds[3], feature.bounds[3]),
    ], [Infinity, Infinity, -Infinity, -Infinity]);

    for (const point of [...unresolved.values()]) {
      if (!pointInBounds(point.lng, point.lat, topologyBounds)) continue;
      for (const feature of features) {
        if (!pointInBounds(point.lng, point.lat, feature.bounds)) continue;
        if (!pointInTopologyGeometry(point.lng, point.lat, feature.geometry, decodedArcs)) continue;
        const properties = feature.geometry.properties || {};
        const prefecture = properties.N03_001 || '';
        const municipality = properties.N03_004 || '';
        if (!municipality || municipality === '所属未定地') continue;
        const location = `${prefecture}${municipality}`;
        municipalityLocationCache.set(point.key, location);
        resolved.set(point.key, location);
        unresolved.delete(point.key);
        break;
      }
    }
  }

  for (const point of unresolved.values()) {
    municipalityLocationCache.set(point.key, null);
    resolved.set(point.key, null);
  }
  return resolved;
}

async function populateRankingLocations(targets) {
  const generation = ++rankingLocationGeneration;
  try {
    const locations = await resolveMunicipalityLocations(targets.map(target => target.cell));
    if (generation !== rankingLocationGeneration) return;
    for (const target of targets) {
      if (!target.place.isConnected) continue;
      const key = rowKey(target.cell.lat_i, target.cell.lng_i);
      const location = locations.get(key);
      target.place.textContent = location || '地域不明';
      target.button.setAttribute(
        'aria-label',
        `第${target.rank}位、${target.cell.remainingVal.toLocaleString()}回、${location || '地域不明'}、地図で見る`
      );
    }
  } catch (error) {
    console.warn('自治体名の判定に失敗しました:', error);
    if (generation !== rankingLocationGeneration) return;
    for (const target of targets) {
      if (target.place.isConnected) target.place.textContent = '地域を判定できません';
    }
  }
}

function calculateInsights() {
  const ranking = [];
  const areaByLatitude = new Map();
  let cellCount = 0;
  let visitCount = 0;
  let areaKm2 = 0;
  let firstVisit = Infinity;
  let lastVisit = -Infinity;

  for (const cell of zoom16Cells) {
    const remainingVal = displayedValue(16, cell.lat_i, cell.lng_i, cell.val);
    if (remainingVal <= 0) continue;
    const bounds = cellVisitBounds(cell);
    cellCount++;
    visitCount += remainingVal;
    if (!areaByLatitude.has(cell.lat_i)) {
      areaByLatitude.set(cell.lat_i, zoom16CellAreaKm2(cell.lat_i));
    }
    areaKm2 += areaByLatitude.get(cell.lat_i);
    if (Number.isFinite(bounds.first) && bounds.first > 0) firstVisit = Math.min(firstVisit, bounds.first);
    if (Number.isFinite(bounds.last) && bounds.last > 0) lastVisit = Math.max(lastVisit, bounds.last);
    ranking.push({ ...cell, remainingVal, firstVisit: bounds.first, lastVisit: bounds.last });
  }

  ranking.sort((a, b) => b.remainingVal - a.remainingVal || b.lastVisit - a.lastVisit);
  return {
    cellCount,
    visitCount,
    areaKm2,
    firstVisit: Number.isFinite(firstVisit) ? firstVisit : null,
    lastVisit: Number.isFinite(lastVisit) ? lastVisit : null,
    ranking: ranking.slice(0, RANKING_LIMIT),
  };
}

function focusRankingCell(cell) {
  if (!map) return;
  if (eraserActive) setEraserActive(false);
  const center = L.latLng(
    (cell.lat_i + 0.5) / K - 90,
    (cell.lng_i + 0.5) / K - 180
  );
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    showCellInfo(center).catch(console.error);
  };
  map.once('moveend', show);
  const sameZoom = map.getZoom() === 16;
  const size = map.getSize();
  const destination = map.latLngToContainerPoint(center);
  const distance = destination.distanceTo(size.divideBy(2));
  const canSlideCanvas = sameZoom && distance > 1 && distance <= Math.max(size.x, size.y) * 1.5;

  if (canSlideCanvas) {
    const anchor = map.getCenter();
    const finalOffset = size.divideBy(2).subtract(destination);
    rankingPanSync = {
      anchor,
      origin: map.latLngToContainerPoint(anchor),
      frame: {
        left: Math.max(0, Math.ceil(finalOffset.x)),
        right: Math.max(0, Math.ceil(-finalOffset.x)),
        top: Math.max(0, Math.ceil(finalOffset.y)),
        bottom: Math.max(0, Math.ceil(-finalOffset.y)),
      },
    };
    canvas.style.transition = 'none';
    canvas.style.transformOrigin = '0 0';
    redraw();
    map.panTo(center, { animate: true, duration: 0.3 });
  } else {
    rankingPanSync = null;
    map.setView(center, 16, { animate: !sameZoom });
  }
  setTimeout(show, 450);
  if (window.matchMedia('(max-width: 560px)').matches) setInsightsPanelOpen(false);
}

function renderInsights() {
  if (!insightsReady) {
    $('insights-loading').classList.remove('hidden');
    $('insights-content').classList.add('hidden');
    return;
  }

  const stats = calculateInsights();
  $('insights-loading').classList.add('hidden');
  $('insights-content').classList.remove('hidden');
  $('stats-cell-count').textContent = `${stats.cellCount.toLocaleString()}セル`;
  $('stats-visit-count').textContent = `${stats.visitCount.toLocaleString()}回`;
  $('stats-area').textContent = formatArea(stats.areaKm2);
  $('stats-date-range').textContent = stats.firstVisit && stats.lastVisit
    ? `${formatStatDate(stats.firstVisit)}〜${formatStatDate(stats.lastVisit)}`
    : '—';
  $('municipality-comparison').textContent = formatMunicipalityComparison(stats.areaKm2);

  const list = $('ranking-list');
  list.replaceChildren();
  if (stats.ranking.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'ranking-empty';
    empty.textContent = '表示できるセルがありません';
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const locationTargets = [];
  stats.ranking.forEach((cell, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ranking-button';
    button.setAttribute('aria-label', `第${index + 1}位、${cell.remainingVal.toLocaleString()}回、地図で見る`);
    button.innerHTML = `
      <span class="ranking-number">#${index + 1}</span>
      <span class="ranking-main">
        <span class="ranking-count">${cell.remainingVal.toLocaleString()}回</span>
        <span class="ranking-meta">
          <span>最終訪問 ${formatStatDate(cell.lastVisit)}</span>
          <span class="ranking-meta-separator" aria-hidden="true">·</span>
          <span class="ranking-place">地域を確認中…</span>
        </span>
      </span>
      <span class="ranking-arrow" aria-hidden="true">›</span>`;
    button.addEventListener('click', () => focusRankingCell(cell));
    locationTargets.push({
      rank: index + 1,
      cell,
      button,
      place: button.querySelector('.ranking-place'),
    });
    item.appendChild(button);
    fragment.appendChild(item);
  });
  list.appendChild(fragment);
  if (!$('insights-panel').classList.contains('hidden')) {
    populateRankingLocations(locationTargets);
  }
}

function scheduleInsightsUpdate() {
  if (!insightsReady) return;
  clearTimeout(insightsUpdateTimer);
  insightsUpdateTimer = setTimeout(renderInsights, 80);
}

async function prepareInsights() {
  if (!innerZip || insightsLoading) return;
  const generation = ++insightsGeneration;
  insightsLoading = true;
  insightsReady = false;
  $('insights-btn').disabled = false;

  const tiles = [];
  innerZip.forEach(path => {
    const match = path.match(/^hm_16_(\d+)_(\d+)\.db$/);
    if (match) tiles.push({ a: Number(match[1]), b: Number(match[2]) });
  });

  let nextIndex = 0;
  let completed = 0;
  const updateLoadingText = () => {
    $('insights-loading').textContent = `訪問データを集計しています… ${completed.toLocaleString()} / ${tiles.length.toLocaleString()}タイル`;
  };
  updateLoadingText();

  const worker = async () => {
    while (nextIndex < tiles.length) {
      const tile = tiles[nextIndex++];
      await loadTile(16, tile.a, tile.b);
      completed++;
      if (generation === insightsGeneration && (completed % 5 === 0 || completed === tiles.length)) {
        updateLoadingText();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, worker));
  if (generation !== insightsGeneration) return;

  const uniqueCells = new Map();
  for (const tile of tiles) {
    for (const cell of tileCache.get(`16_${tile.a}_${tile.b}`) || []) {
      uniqueCells.set(rowKey(cell.lat_i, cell.lng_i), cell);
    }
  }
  zoom16Cells = [...uniqueCells.values()];
  insightsLoading = false;
  insightsReady = true;
  updateCount();
  renderInsights();
}

// ========================= タイル読み込み =========================

async function loadTile(appZoom, a, b) {
  const key = `${appZoom}_${a}_${b}`;
  if (tileCache.has(key)) return;
  if (loadingTasks.has(key)) return loadingTasks.get(key);

  const task = (async () => {
    const entry = innerZip?.file(`hm_${appZoom}_${a}_${b}.db`);
    if (!entry) {
      tileCache.set(key, []);
      return;
    }

    try {
      const enc = await entry.async('uint8array');
      const dec = xorDecrypt(enc);
      const db  = new SQL.Database(dec);
      const res = db.exec('SELECT lat, lng, val, tm, p1, p2, p3, p4 FROM heatmap_table');
      db.close();

      const cells = res[0]?.values.map(([lat_i, lng_i, val, tm, p1, p2, p3, p4]) =>
        ({ lat_i, lng_i, val: val ?? 1, tm, p1, p2: p2 ?? 0, p3: p3 ?? 0, p4: p4 ?? 0 })) ?? [];

      totalCells += cells.length;
      tileCache.set(key, cells);
      updateCount();
    } catch (e) {
      console.warn(`tile ${key}:`, e);
      tileCache.set(key, []);
    }
  })();

  loadingTasks.set(key, task);
  try {
    await task;
  } finally {
    if (loadingTasks.get(key) === task) loadingTasks.delete(key);
  }
}

// ========================= 描画 =========================

// カラーストップ：[val, [R, G, B]]
// 本家アプリの実測色（白背景に alpha=0.6 でブレンドされた状態）から逆算した純色。
// 逆算式: cell = (measured - 255*0.4) / 0.6
// 実測 → 純色:
//   val=1  (112,111,155) → (17, 15, 88)   深い青
//   val=4  (124,164,241) → (37,103,232)   水色
//   val=9  (163,244,128) → (102,237, 43)  緑
//   val=15 (232,119,115) → (217, 28, 22)  赤
const COLOR_STOPS = [
  [ 1, [ 17,  15,  88]],  // 1回:  深い青
  [ 4, [ 37, 103, 232]],  // 4回:  水色
  [ 9, [102, 237,  43]],  // 9回:  緑
  [15, [217,  28,  22]],  // 15回+: 赤
];

function cellFillColor(normVal) {
  const v = Math.max(0, normVal);
  // 上限
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  if (v >= last[0]) return `rgb(${last[1].join(',')})`;
  // 下限（v < 最初のストップ）
  const first = COLOR_STOPS[0];
  if (v <= first[0]) return `rgb(${first[1].join(',')})`;
  // 線形補間
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [v0, [r0, g0, b0]] = COLOR_STOPS[i];
    const [v1, [r1, g1, b1]] = COLOR_STOPS[i + 1];
    if (v <= v1) {
      const t = (v - v0) / (v1 - v0);
      return `rgb(${Math.round(r0+(r1-r0)*t)},${Math.round(g0+(g1-g0)*t)},${Math.round(b0+(b1-b0)*t)})`;
    }
  }
  return `rgb(${first[1].join(',')})`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatVisitTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '記録なし';
  return dateTimeFormatter.format(new Date(value));
}

function cellVisitBounds(cell) {
  const last = Number(cell.tm);
  const first = Number(cell.p1) > 0 ? Number(cell.p1) : last;
  return { first, last };
}

function cellMatchesDateFilter(cell) {
  if (!isDateFilterActive()) return true;
  const { first, last } = cellVisitBounds(cell);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return (dateFilterStart === null || last >= dateFilterStart) &&
    (dateFilterEndExclusive === null || first < dateFilterEndExclusive);
}

function parseLocalDateStart(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function applyDateFilter() {
  const startValue = $('date-filter-start').value;
  const endValue = $('date-filter-end').value;
  const start = parseLocalDateStart(startValue);
  const endStart = parseLocalDateStart(endValue);
  let endExclusive = null;
  if (endStart !== null) {
    const endDate = new Date(endStart);
    endDate.setDate(endDate.getDate() + 1);
    endExclusive = endDate.getTime();
  }
  if (start !== null && endExclusive !== null && start >= endExclusive) {
    showToast('開始日は終了日以前にしてください');
    return;
  }

  if (eraserActive) setEraserActive(false);
  dateFilterStart = start;
  dateFilterEndExclusive = endExclusive;
  closeCellInfo();
  redraw();
  updateEditUI();
  setDateFilterPanelOpen(false);
  $('date-filter-btn').focus();
  showToast(isDateFilterActive() ? '期間で絞り込みました' : '期間絞り込みを解除しました');
}

function clearDateFilter() {
  $('date-filter-start').value = '';
  $('date-filter-end').value = '';
  applyDateFilter();
}

function setDateFilterPanelOpen(open) {
  const panel = $('date-filter-panel');
  const button = $('date-filter-btn');
  panel.classList.toggle('hidden', !open);
  button.setAttribute('aria-expanded', String(open));
  if (open) $('date-filter-start').focus();
}

function closeCellInfo() {
  cellPopupLatLng = null;
  const popup = $('cell-popup');
  if (popup) popup.classList.add('hidden');
}

function cellPopupPath(width, height, arrowX, placeBelow) {
  const r = Math.min(CELL_POPUP_RADIUS, width / 2, height / 2);
  const halfArrow = CELL_POPUP_ARROW_WIDTH / 2;

  if (placeBelow) {
    const top = CELL_POPUP_ARROW_HEIGHT;
    return [
      `M ${r} ${top}`,
      `H ${arrowX - halfArrow}`,
      `L ${arrowX} 0`,
      `L ${arrowX + halfArrow} ${top}`,
      `H ${width - r}`,
      `Q ${width} ${top} ${width} ${top + r}`,
      `V ${height - r}`,
      `Q ${width} ${height} ${width - r} ${height}`,
      `H ${r}`,
      `Q 0 ${height} 0 ${height - r}`,
      `V ${top + r}`,
      `Q 0 ${top} ${r} ${top}`,
      'Z',
    ].join(' ');
  }

  const bottom = height - CELL_POPUP_ARROW_HEIGHT;
  return [
    `M ${r} 0`,
    `H ${width - r}`,
    `Q ${width} 0 ${width} ${r}`,
    `V ${bottom - r}`,
    `Q ${width} ${bottom} ${width - r} ${bottom}`,
    `H ${arrowX + halfArrow}`,
    `L ${arrowX} ${height}`,
    `L ${arrowX - halfArrow} ${bottom}`,
    `H ${r}`,
    `Q 0 ${bottom} 0 ${bottom - r}`,
    `V ${r}`,
    `Q 0 0 ${r} 0`,
    'Z',
  ].join(' ');
}

function positionCellInfo() {
  const popup = $('cell-popup');
  if (!map || !cellPopupLatLng || !popup || popup.classList.contains('hidden')) return;

  const point = map.latLngToContainerPoint(cellPopupLatLng);
  const container = map.getContainer();
  const popupRect = popup.getBoundingClientRect();
  const padding = 12;
  const halfWidth = popupRect.width / 2;
  const minLeft = padding + halfWidth;
  const maxLeft = container.clientWidth - padding - halfWidth;
  const left = Math.max(minLeft, Math.min(maxLeft, point.x));
  const placeBelow = point.y - popupRect.height - 18 < padding;
  const arrowX = Math.max(20, Math.min(popupRect.width - 20, halfWidth + point.x - left));
  const path = cellPopupPath(popupRect.width, popupRect.height, arrowX, placeBelow);

  popup.classList.toggle('is-below', placeBelow);
  popup.style.left = `${left}px`;
  popup.style.top = `${point.y}px`;
  $('cell-popup-clip-path').setAttribute('d', path);
  $('cell-popup-outline-path').setAttribute('d', path);
  $('cell-popup-outline').setAttribute('viewBox', `0 0 ${popupRect.width} ${popupRect.height}`);
}

async function showCellInfo(latlng) {
  if (!innerZip || eraserActive) return;
  const requestId = ++cellInfoRequestId;
  const appZoom = getAppZoom(map.getZoom());
  const Kz = getKz(appZoom);
  const lat_i = Math.floor((latlng.lat + 90) * Kz);
  const lng_i = Math.floor((latlng.lng + 180) * Kz);
  const a = Math.floor(lat_i / 1000);
  const b = Math.floor(lng_i / 1000);

  await loadTile(appZoom, a, b);
  if (requestId !== cellInfoRequestId || appZoom !== getAppZoom(map.getZoom())) return;

  const cell = tileCache.get(`${appZoom}_${a}_${b}`)
    ?.find(item => item.lat_i === lat_i && item.lng_i === lng_i);
  const remainingVal = cell ? displayedValue(appZoom, lat_i, lng_i, cell.val) : 0;
  if (!cell || remainingVal <= 0 || !cellMatchesDateFilter(cell)) {
    closeCellInfo();
    return;
  }

  // tm は最終記録時刻。p1 は複数記録時の初回記録時刻で、1件時は 0 のため tm を使う。
  const firstVisit = cell.p1 > 0 ? cell.p1 : cell.tm;
  const center = L.latLng(
    (lat_i + 0.5) / Kz - 90,
    (lng_i + 0.5) / Kz - 180
  );
  const color = cellFillColor(normalizeVal(remainingVal, appZoom));
  $('cell-popup-content').innerHTML = `
    <div class="cell-info">
      <div class="cell-info-title"><span style="background:${color}"></span>このセルの記録</div>
      <dl>
        <div><dt>記録回数</dt><dd>${remainingVal.toLocaleString()}回</dd></div>
        <div><dt>初回訪問</dt><dd>${formatVisitTime(firstVisit)}</dd></div>
        <div><dt>最終訪問</dt><dd>${formatVisitTime(cell.tm)}</dd></div>
        <div><dt>表示セル</dt><dd>Zoom ${appZoom}</dd></div>
      </dl>
      ${isDateFilterActive() ? '<p class="cell-info-filter-note">回数は全期間の累計です</p>' : ''}
    </div>`;

  cellPopupLatLng = center;
  const popup = $('cell-popup');
  popup.style.visibility = 'hidden';
  popup.classList.remove('hidden');
  positionCellInfo();
  popup.style.visibility = '';
}

// ズームアウト時の val → zoom16 基準の正規化
// 面積比(4^)ではなく線形スケール(2^)で割ることで青偏りを防ぐ
// zoom14: /4, zoom12: /16, zoom8: /256
function normalizeVal(rawVal, appZoom) {
  return rawVal / Math.pow(2, 16 - appZoom);
}

function rowKey(lat, lng) { return `${lat},${lng}`; }

function changeCellDeletion(cell, direction) {
  for (let z = 2; z <= 16; z++) {
    const scale = Math.pow(2, 16 - z);
    const lat = Math.floor(cell.lat_i / scale);
    const lng = Math.floor(cell.lng_i / scale);
    if (!deletionDeltas.has(z)) deletionDeltas.set(z, new Map());
    const zoomDeltas = deletionDeltas.get(z);
    const key = rowKey(lat, lng);
    const d = zoomDeltas.get(key) || { lat, lng, val: 0, p2: 0, p3: 0, p4: 0 };
    for (const field of ['val', 'p2', 'p3', 'p4']) d[field] += direction * (cell[field] || 0);
    if (d.val === 0 && d.p2 === 0 && d.p3 === 0 && d.p4 === 0) zoomDeltas.delete(key);
    else zoomDeltas.set(key, d);
  }
}

function addDeletedCell(cell) {
  const key = rowKey(cell.lat_i, cell.lng_i);
  if (deletedCells.has(key)) return false;
  deletedCells.set(key, cell);
  changeCellDeletion(cell, 1);
  return true;
}

function restoreDeletedCell(cell) {
  const key = rowKey(cell.lat_i, cell.lng_i);
  if (!deletedCells.delete(key)) return false;
  changeCellDeletion(cell, -1);
  return true;
}

function displayedValue(appZoom, lat, lng, originalValue) {
  const delta = deletionDeltas.get(appZoom)?.get(rowKey(lat, lng));
  return originalValue - (delta?.val || 0);
}

const GRID_COLOR = '#1a1a1a';  // 全セルの外枠（暗色）

// 現在ビューポートに対し、指定ズームのキャッシュ済みタイルが1枚以上あるか
function hasCachedTiles(appZoom) {
  const bounds = map.getBounds();
  const f = getKz(appZoom) / 1000;
  const aMin = Math.floor((bounds.getSouth() + 90)  * f);
  const aMax = Math.floor((bounds.getNorth() + 90)  * f);
  const bMin = Math.floor((bounds.getWest()  + 180) * f);
  const bMax = Math.floor((bounds.getEast()  + 180) * f);
  for (let a = aMin; a <= aMax; a++)
    for (let b = bMin; b <= bMax; b++)
      if (tileCache.get(`${appZoom}_${a}_${b}`)?.length > 0) return true;
  return false;
}

function redraw() {
  if (!ctx || !map || isZooming) return;
  const container = map.getContainer();
  const frame = rankingPanSync?.frame || { left: 0, right: 0, top: 0, bottom: 0 };
  const renderWidth = container.offsetWidth + frame.left + frame.right;
  const renderHeight = container.offsetHeight + frame.top + frame.bottom;
  // サイズが変わった時だけリサイズ（毎フレームのリセットでちらつき防止）
  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width  = renderWidth;
    canvas.height = renderHeight;
  }
  canvas.style.left = `${-frame.left}px`;
  canvas.style.top = `${-frame.top}px`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!innerZip) return;

  // 理想のズームにキャッシュがなければ隣接ズームにフォールバック（低解像度プレビュー）
  const preferred = getAppZoom(map.getZoom());
  let appZoom = preferred;
  if (!hasCachedTiles(preferred)) {
    for (const d of [2, -2, 4, -4, 6, -6]) {
      const z = preferred + d;
      if (z < 4 || z > 16) continue;
      if (hasCachedTiles(z)) { appZoom = z; break; }
    }
  }
  const Kz      = getKz(appZoom);
  const cellDeg = 1 / Kz;          // 1セル = cellDeg 度
  const northWest = map.containerPointToLatLng(L.point(-frame.left, -frame.top));
  const southEast = map.containerPointToLatLng(L.point(
    container.offsetWidth + frame.right,
    container.offsetHeight + frame.bottom
  ));
  const f       = Kz / 1000;       // タイル番号算出係数

  // 描画タイル範囲
  const aMin = Math.floor((southEast.lat + 90) * f);
  const aMax = Math.floor((northWest.lat + 90) * f);
  const bMin = Math.floor((northWest.lng + 180) * f);
  const bMax = Math.floor((southEast.lng + 180) * f);

  // グリッド描画の表示判定に使う代表セル幅
  const center = map.getCenter();
  const pC = map.latLngToContainerPoint(center);
  const pE = map.latLngToContainerPoint(L.latLng(center.lat, center.lng + cellDeg));
  const representativeCellPxW = Math.abs(pE.x - pC.x);

  // Web Mercator では x は経度だけ、y は緯度だけで決まる。
  // 各グリッド境界を Leaflet の投影で正確に求め、同じ座標はキャッシュする。
  // 地図中央での線形近似を使わないため、緯度やズーム倍率による位置ずれが出ない。
  const xCache = new Map();
  const yCache = new Map();

  function gridX(lng_i) {
    if (!xCache.has(lng_i)) {
      const lng = lng_i / Kz - 180;
      xCache.set(lng_i, map.latLngToContainerPoint(L.latLng(center.lat, lng)).x + frame.left);
    }
    return xCache.get(lng_i);
  }

  function gridY(lat_i) {
    if (!yCache.has(lat_i)) {
      const lat = lat_i / Kz - 90;
      yCache.set(lat_i, map.latLngToContainerPoint(L.latLng(lat, center.lng)).y + frame.top);
    }
    return yCache.get(lat_i);
  }

  function cellRect(lat_i, lng_i) {
    const left   = gridX(lng_i);
    const right  = gridX(lng_i + 1);
    const bottom = gridY(lat_i);
    const top    = gridY(lat_i + 1);
    return {
      x: Math.min(left, right),
      y: Math.min(top, bottom),
      width: Math.abs(right - left),
      height: Math.abs(bottom - top),
    };
  }

  // 背景地図を残しつつ、従来より彩度が伝わる alpha で描画する。
  // ★ 二重合成を避けるため2パス構成:
  //    Pass1: 塗り色を直接描画（1回だけ合成 → 正しい明度）
  //    Pass2: 細いグリッドストロークを上書き
  ctx.save();
  ctx.globalAlpha = CELL_ALPHA;

  // Pass1: 塗り色（フルセルサイズ）
  const drawGrid = representativeCellPxW >= 4;
  const drawnRects = drawGrid ? [] : null;
  for (let a = aMin; a <= aMax; a++) {
    for (let b = bMin; b <= bMax; b++) {
      const cells = tileCache.get(`${appZoom}_${a}_${b}`);
      if (!cells) continue;
      for (const cell of cells) {
        const { lat_i, lng_i, val } = cell;
        if (!cellMatchesDateFilter(cell)) continue;
        const remainingVal = displayedValue(appZoom, lat_i, lng_i, val);
        if (remainingVal <= 0) continue;
        const rect = cellRect(lat_i, lng_i);
        ctx.fillStyle = cellFillColor(normalizeVal(remainingVal, appZoom));
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        if (drawnRects) drawnRects.push(rect);
      }
    }
  }

  // Pass2: グリッドストローク（セルが十分大きい時だけ描画）
  if (drawGrid) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = Math.min(1.5, representativeCellPxW * 0.1);
    ctx.beginPath();
    for (const rect of drawnRects) {
      ctx.rect(
        rect.x + 0.5,
        rect.y + 0.5,
        Math.max(0, rect.width - 1),
        Math.max(0, rect.height - 1)
      );
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ========================= 消しゴム編集 =========================

async function eraseAtContainerPoint(point, radius = 15) {
  if (!eraserActive || currentAppZoom() < MIN_EDIT_ZOOM || !innerZip) return;
  const northWest = map.containerPointToLatLng(L.point(point.x - radius, point.y - radius));
  const southEast = map.containerPointToLatLng(L.point(point.x + radius, point.y + radius));
  const f = K / 1000;
  const aMin = Math.floor((southEast.lat + 90) * f);
  const aMax = Math.floor((northWest.lat + 90) * f);
  const bMin = Math.floor((northWest.lng + 180) * f);
  const bMax = Math.floor((southEast.lng + 180) * f);

  const tileJobs = [];
  for (let a = aMin; a <= aMax; a++) {
    for (let b = bMin; b <= bMax; b++) tileJobs.push(loadTile(16, a, b));
  }
  await Promise.all(tileJobs);
  if (!activeStroke) return;

  for (let a = aMin; a <= aMax; a++) {
    for (let b = bMin; b <= bMax; b++) {
      for (const cell of tileCache.get(`16_${a}_${b}`) || []) {
        const key = rowKey(cell.lat_i, cell.lng_i);
        if (deletedCells.has(key)) continue;
        const center = map.latLngToContainerPoint(L.latLng(
          (cell.lat_i + 0.5) / K - 90,
          (cell.lng_i + 0.5) / K - 180
        ));
        if (center.distanceTo(point) <= radius + 2 && addDeletedCell(cell)) {
          activeStroke.set(key, cell);
        }
      }
    }
  }
  redraw();
  updateEditUI();
}

function queueBrushPoint(point) {
  brushQueue = brushQueue.then(() => eraseAtContainerPoint(point)).catch(console.error);
}

function queueBrushSegment(from, to) {
  const distance = from ? from.distanceTo(to) : 0;
  const steps = Math.max(1, Math.ceil(distance / 7));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    queueBrushPoint(L.point(
      from ? from.x + (to.x - from.x) * t : to.x,
      from ? from.y + (to.y - from.y) * t : to.y
    ));
  }
}

async function finishStroke() {
  await brushQueue;
  if (activeStroke?.size) {
    undoStack.push([...activeStroke.values()]);
    redoStack = [];
  }
  activeStroke = null;
  updateEditUI();
}

function undoEdit() {
  const action = undoStack.pop();
  if (!action) return;
  for (const cell of action) restoreDeletedCell(cell);
  redoStack.push(action);
  redraw();
  updateEditUI();
}

function redoEdit() {
  const action = redoStack.pop();
  if (!action) return;
  for (const cell of action) addDeletedCell(cell);
  undoStack.push(action);
  redraw();
  updateEditUI();
}

// ========================= 更新ロジック =========================

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(doUpdate, 150);
}

async function doUpdate() {
  if (!innerZip || isZooming) return;
  const generation = ++updateGeneration;

  redraw();  // キャッシュ済みタイル or フォールバックズームで即時描画

  const appZoom = getAppZoom(map.getZoom());
  const Kz      = getKz(appZoom);
  const bounds  = map.getBounds();
  const f       = Kz / 1000;

  const aMin = Math.floor((bounds.getSouth() + 90)  * f);
  const aMax = Math.floor((bounds.getNorth() + 90)  * f);
  const bMin = Math.floor((bounds.getWest()  + 180) * f);
  const bMax = Math.floor((bounds.getEast()  + 180) * f);

  const toLoad = [];
  for (let a = aMin; a <= aMax; a++)
    for (let b = bMin; b <= bMax; b++)
      if (!tileCache.has(`${appZoom}_${a}_${b}`)) toLoad.push([a, b]);

  if (toLoad.length > 0) {
    setStatus(`読み込み中... (${toLoad.length} タイル / zoom ${appZoom})`);
    setProgress(0);
    let done = 0;
    await Promise.all(toLoad.map(async ([a, b]) => {
      await loadTile(appZoom, a, b);
      done++;
      if (generation === updateGeneration && !isZooming) {
        setProgress(Math.round(done / toLoad.length * 100));
      }
    }));
  }

  // 読込中に次のズームや更新が始まった場合、古い表示条件では描画しない。
  if (generation !== updateGeneration || isZooming) return;

  redraw();

  // 表示セル数を集計
  let visible = 0;
  for (let a = aMin; a <= aMax; a++)
    for (let b = bMin; b <= bMax; b++)
      visible += tileCache.get(`${appZoom}_${a}_${b}`)?.length ?? 0;

  setStatus(`zoom ${appZoom} | 表示中 ${visible.toLocaleString()} cells`);
  setProgress(100);
}

// ========================= .mapping 書き出し =========================

function exportFilename(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.mapping`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportEditedMapping() {
  if (!sourceFileBytes || deletedCells.size === 0) return;
  const saveButton = $('save-btn');
  saveButton.disabled = true;
  setStatus('編集済みファイルを作成中...');
  setProgress(3);

  try {
    const expectedRemoved = [...deletedCells.values()].reduce((sum, cell) => sum + (cell.val || 0), 0);
    for (let z = 2; z <= 16; z++) {
      const sum = [...(deletionDeltas.get(z)?.values() || [])]
        .reduce((total, delta) => total + delta.val, 0);
      if (sum !== expectedRemoved) throw new Error(`zoom ${z} の削除量が一致しません`);
    }

    const outer = await JSZip.loadAsync(sourceFileBytes);
    let backupPath = null;
    outer.forEach(path => { if (path.endsWith('.backup')) backupPath = path; });
    if (!backupPath) throw new Error('.backup が見つかりません');
    const originalBackupEntry = outer.file(backupPath);
    const backupBytes = await originalBackupEntry.async('uint8array');
    const exportInner = await JSZip.loadAsync(backupBytes.slice(HEADER_LEN));

    const grouped = new Map();
    for (let z = 2; z <= 16; z++) {
      for (const delta of deletionDeltas.get(z)?.values() || []) {
        const path = `hm_${z}_${Math.floor(delta.lat / 1000)}_${Math.floor(delta.lng / 1000)}.db`;
        if (!grouped.has(path)) grouped.set(path, { z, deltas: [] });
        grouped.get(path).deltas.push(delta);
      }
    }

    let completed = 0;
    for (const [path, group] of grouped) {
      const entry = exportInner.file(path);
      if (!entry) throw new Error(`編集対象のデータベースが見つかりません: ${path}`);
      const encrypted = await entry.async('uint8array');
      const db = new SQL.Database(xorDecrypt(encrypted));
      try {
        db.run('BEGIN TRANSACTION');
        for (const delta of group.deltas) {
          const found = db.exec(
            `SELECT val, COALESCE(p2,0), COALESCE(p3,0), COALESCE(p4,0)
             FROM heatmap_table WHERE lat=${Number(delta.lat)} AND lng=${Number(delta.lng)}`
          );
          if (!found[0]?.values.length) {
            throw new Error(`編集対象セルが見つかりません: z${group.z} ${delta.lat},${delta.lng}`);
          }
          const [val, p2, p3, p4] = found[0].values[0];
          if (val < delta.val || p2 < delta.p2 || p3 < delta.p3 || p4 < delta.p4) {
            throw new Error(`削除量が元データを超えています: z${group.z} ${delta.lat},${delta.lng}`);
          }
          if (val === delta.val) {
            db.run('DELETE FROM heatmap_table WHERE lat=? AND lng=?', [delta.lat, delta.lng]);
          } else {
            db.run(
              `UPDATE heatmap_table SET val=val-?, p2=COALESCE(p2,0)-?,
               p3=COALESCE(p3,0)-?, p4=COALESCE(p4,0)-? WHERE lat=? AND lng=?`,
              [delta.val, delta.p2, delta.p3, delta.p4, delta.lat, delta.lng]
            );
          }
        }
        db.run('COMMIT');
        const exported = db.export();
        exportInner.file(path, xorDecrypt(exported), {
          binary: true,
          date: entry.date,
          compression: 'DEFLATE',
        });
      } catch (error) {
        try { db.run('ROLLBACK'); } catch (_) { /* no-op */ }
        throw error;
      } finally {
        db.close();
      }
      completed++;
      setProgress(5 + Math.round(completed / grouped.size * 70));
    }

    const innerBytes = await exportInner.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const rebuiltBackup = new Uint8Array(HEADER_LEN + innerBytes.length);
    rebuiltBackup.set(backupBytes.slice(0, HEADER_LEN), 0);
    rebuiltBackup.set(innerBytes, HEADER_LEN);
    outer.file(backupPath, rebuiltBackup, {
      binary: true,
      date: originalBackupEntry.date,
      compression: 'DEFLATE',
      createFolders: false,
    });
    setProgress(85);

    const output = await outer.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const filename = exportFilename();
    downloadBlob(output, filename);
    setProgress(100);
    setStatus(`${filename} を保存しました（元ファイルは変更していません）`);
    showToast('編集済みファイルを保存しました');
  } catch (error) {
    console.error(error);
    setStatus(`書き出しエラー: ${error.message}`);
    showToast('書き出しに失敗しました。元ファイルは変更されていません');
  } finally {
    updateEditUI();
  }
}

// ========================= バックアップのマージ =========================

function mergeRowKey(lat, lng) { return `${lat},${lng}`; }
function mergeRowFirst(row) {
  const first = Number(row?.p1) || Number(row?.tm) || 0;
  return first > 0 ? first : 0;
}
function formatMergeDate(timestamp) {
  if (!(timestamp > 0)) return '不明';
  return new Date(timestamp).toLocaleString('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function readMergeSource(file, progress) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const outer = await JSZip.loadAsync(bytes);
  let backupPath = null;
  outer.forEach(path => { if (path.endsWith('.backup')) backupPath = path; });
  if (!backupPath) throw new Error(`${file.name}: .backup が見つかりません`);
  const backupEntry = outer.file(backupPath);
  const backupBytes = await backupEntry.async('uint8array');
  if (!new TextDecoder().decode(backupBytes.slice(0, 18)).startsWith('MyAllTracksBackup')) {
    throw new Error(`${file.name}: 未対応フォーマットです`);
  }
  const zip = await JSZip.loadAsync(backupBytes.slice(HEADER_LEN));
  const paths = [];
  zip.forEach(path => { if (/^hm_16_\d+_\d+\.db$/.test(path)) paths.push(path); });
  const cells = new Map();
  let first = Infinity;
  let last = -Infinity;
  let visits = 0;
  for (let index = 0; index < paths.length; index++) {
    const encrypted = await zip.file(paths[index]).async('uint8array');
    const db = new SQL.Database(xorDecrypt(encrypted));
    try {
      const result = db.exec('SELECT lat,lng,val,tm,p1,p2,p3,p4 FROM heatmap_table');
      for (const values of result[0]?.values || []) {
        const row = {
          lat: Number(values[0]), lng: Number(values[1]), val: Number(values[2]) || 0,
          tm: Number(values[3]) || 0, p1: Number(values[4]) || 0,
          p2: Number(values[5]) || 0, p3: Number(values[6]) || 0, p4: Number(values[7]) || 0,
        };
        cells.set(mergeRowKey(row.lat, row.lng), row);
        visits += row.val;
        const rowFirst = mergeRowFirst(row);
        if (rowFirst) first = Math.min(first, rowFirst);
        if (row.tm) last = Math.max(last, row.tm);
      }
    } finally {
      db.close();
    }
    if (index % 8 === 0) {
      progress?.((index + 1) / Math.max(1, paths.length));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }
  return {
    file, bytes, backupPath, backupDate: backupEntry.date, backupHeader: backupBytes.slice(0, HEADER_LEN),
    cells, first: Number.isFinite(first) ? first : 0, last: Number.isFinite(last) ? last : 0,
    visits, tileCount: paths.length,
  };
}

function sourceDominates(left, right) {
  for (const [key, row] of right.cells) {
    const candidate = left.cells.get(key);
    if (!candidate || candidate.val < row.val) return false;
  }
  return true;
}

function analyzeMergeSources(a, b) {
  let onlyA = 0, onlyB = 0, equal = 0, differing = 0;
  let aHigher = 0, bHigher = 0;
  const differences = [];
  for (const [key, rowA] of a.cells) {
    const rowB = b.cells.get(key);
    if (!rowB) {
      onlyA++;
      differences.push({ kind: 'a', row: rowA });
    } else if (rowA.val === rowB.val) {
      equal++;
    } else {
      differing++;
      if (rowA.val > rowB.val) aHigher++; else bHigher++;
      differences.push({ kind: 'different', row: rowA.val >= rowB.val ? rowA : rowB });
    }
  }
  for (const [key, rowB] of b.cells) {
    if (!a.cells.has(key)) {
      onlyB++;
      differences.push({ kind: 'b', row: rowB });
    }
  }
  const disjoint = a.last < b.first || b.last < a.first;
  const aContainsPeriod = a.first <= b.first && a.last >= b.last;
  const bContainsPeriod = b.first <= a.first && b.last >= a.last;
  const aDominates = sourceDominates(a, b);
  const bDominates = sourceDominates(b, a);
  let type = 'partial';
  let autoAction = null;
  let editedIndex = null;
  let containingIndex = null;
  if (onlyA === 0 && onlyB === 0 && differing === 0) {
    type = 'identical'; autoAction = { mode: 'max' };
  } else if (disjoint) {
    type = 'disjoint'; autoAction = { mode: 'sum' };
  } else if (aContainsPeriod !== bContainsPeriod) {
    containingIndex = aContainsPeriod ? 0 : 1;
    const containingDominates = containingIndex === 0 ? aDominates : bDominates;
    if (containingDominates) {
      type = 'contained-clean'; autoAction = { mode: 'max' };
    } else {
      type = 'contained-conflict';
      editedIndex = containingIndex;
    }
  } else if (aDominates !== bDominates) {
    type = 'deletion';
    editedIndex = aDominates ? 1 : 0;
  }
  return {
    sources: [a, b], onlyA, onlyB, equal, differing, aHigher, bHigher, differences,
    disjoint, aContainsPeriod, bContainsPeriod, aDominates, bDominates,
    type, autoAction, editedIndex, containingIndex,
  };
}

function mergeChoiceDescription(analysis) {
  switch (analysis.type) {
    case 'identical': return ['内容は同じです', '同じセルと回数が記録されています。新しい名前のコピーを保存できます。'];
    case 'disjoint': return ['記録期間が重なっていません', 'それぞれの記録をそのまま追加して、安全に一本化できます。'];
    case 'contained-clean': return ['一方の記録期間がもう一方を含んでいます', '長い期間側に足りないセルや回数だけを補います。細かな選択は必要ありません。'];
    case 'deletion': return ['同じ期間の記録に、削除されたような違いがあります', '編集済みと思われる側を保つか、もう一方に残っている記録を戻すか選んでください。'];
    case 'contained-conflict': return ['記録期間は含まれていますが、内容に逆向きの違いがあります', '長い期間側を基準にするか、両方に残っている記録を補うか選んでください。'];
    default: return ['記録期間の一部が重なっています', '重なった部分の回数をどう扱うか選んでください。'];
  }
}

function mergeOptions(analysis) {
  if (analysis.autoAction) return [
    { mode: analysis.autoAction.mode, title: 'この内容でまとめる', detail: '元ファイルは変更せず、新しい.mappingファイルを保存します。' },
  ];
  if (analysis.type === 'deletion' || analysis.type === 'contained-conflict') {
    const label = analysis.editedIndex === 0 ? 'A' : 'B';
    return [
      { mode: 'preserve', sourceIndex: analysis.editedIndex, title: `消した状態を保つ（ファイル ${label} を基準）`, detail: '基準側で消えている記録を復活させません。' },
      { mode: 'max', title: '残っている記録を戻す', detail: 'どちらかに残っているセルを採用し、同じセルの回数は大きい方を使います。' },
      { mode: 'preview', title: '地図で違いを確認する', detail: '違う場所を色分けしてから決めます。' },
    ];
  }
  return [
    { mode: 'max', title: '重複を増やさずまとめる（推奨）', detail: '同じセルの回数は大きい方を採用します。通常はこちらが安全です。' },
    { mode: 'sum', title: '両方の回数を足す', detail: '別端末で独立して記録した場合向けです。同じ移動が両方にあると二重になります。' },
    { mode: 'preview', title: '地図で違いを確認する', detail: '違う場所を色分けしてから決めます。' },
  ];
}

function renderMergeAnalysis() {
  const analysis = mergeAnalysis;
  const result = $('merge-result');
  const [title, description] = mergeChoiceDescription(analysis);
  const allStart = Math.min(...analysis.sources.map(source => source.first));
  const allEnd = Math.max(...analysis.sources.map(source => source.last));
  const span = Math.max(1, allEnd - allStart);
  const periodRows = analysis.sources.map((source, index) => {
    const left = (source.first - allStart) / span * 100;
    const width = Math.max(0.8, (source.last - source.first) / span * 100);
    return `<div class="merge-period-row"><span class="merge-period-label">${index ? 'B' : 'A'}</span><div class="merge-period-track"><span class="merge-period-bar" style="left:${left}%;width:${width}%"></span></div><span class="merge-period-date">${formatMergeDate(source.first)} 〜 ${formatMergeDate(source.last)} · ${source.cells.size.toLocaleString()}セル</span></div>`;
  }).join('');
  const options = mergeOptions(analysis).map((option, index) =>
    `<button class="merge-option" type="button" data-merge-option="${index}"><strong>${option.title}</strong><span>${option.detail}</span></button>`
  ).join('');
  result.innerHTML = `<h3>${title}</h3><p>${description}</p><div class="merge-periods">${periodRows}</div><p>Aだけ ${analysis.onlyA.toLocaleString()}セル・Bだけ ${analysis.onlyB.toLocaleString()}セル・回数が違う共有セル ${analysis.differing.toLocaleString()}件</p><div class="merge-options">${options}</div>`;
  result.classList.remove('hidden');
  const choices = mergeOptions(analysis);
  result.querySelectorAll('[data-merge-option]').forEach(button => {
    button.addEventListener('click', () => selectMergeOption(choices[Number(button.dataset.mergeOption)]));
  });
}

async function analyzeSelectedMergeFiles() {
  if (mergeBusy || !mergeFiles[0] || !mergeFiles[1]) return;
  mergeBusy = true;
  $('merge-analyze').disabled = true;
  $('merge-result').classList.add('hidden');
  $('merge-progress').classList.remove('hidden');
  try {
    mergeSources = [];
    for (let index = 0; index < 2; index++) {
      $('merge-progress').textContent = `ファイル ${index ? 'B' : 'A'} を解析中…`;
      mergeSources[index] = await readMergeSource(mergeFiles[index], ratio => {
        $('merge-progress').textContent = `ファイル ${index ? 'B' : 'A'} を解析中… ${Math.round(ratio * 100)}%`;
      });
    }
    $('merge-progress').textContent = '違いを比較しています…';
    await new Promise(resolve => requestAnimationFrame(resolve));
    mergeAnalysis = analyzeMergeSources(mergeSources[0], mergeSources[1]);
    renderMergeAnalysis();
    $('merge-progress').classList.add('hidden');
  } catch (error) {
    console.error(error);
    $('merge-progress').textContent = `解析できませんでした: ${error.message}`;
  } finally {
    mergeBusy = false;
    $('merge-analyze').disabled = !(mergeFiles[0] && mergeFiles[1]);
  }
}

function combinedMergeRow(a, b, mode) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const val = mode === 'sum' ? a.val + b.val : Math.max(a.val, b.val);
  const firstValues = [mergeRowFirst(a), mergeRowFirst(b)].filter(Boolean);
  const first = firstValues.length ? Math.min(...firstValues) : 0;
  return {
    lat: a.lat, lng: a.lng, val,
    tm: Math.max(a.tm || 0, b.tm || 0),
    p1: val > 1 ? first : 0,
    p2: mode === 'sum' ? (a.p2 || 0) + (b.p2 || 0) : Math.max(a.p2 || 0, b.p2 || 0),
    p3: mode === 'sum' ? (a.p3 || 0) + (b.p3 || 0) : Math.max(a.p3 || 0, b.p3 || 0),
    p4: mode === 'sum' ? (a.p4 || 0) + (b.p4 || 0) : Math.max(a.p4 || 0, b.p4 || 0),
  };
}

function chooseMergeTemplate(analysis, option) {
  if (option.mode === 'preserve') return option.sourceIndex;
  if (analysis.containingIndex !== null) return analysis.containingIndex;
  return analysis.sources[1].last >= analysis.sources[0].last ? 1 : 0;
}

function createHeatmapDatabase() {
  const db = new SQL.Database();
  db.run('CREATE TABLE android_metadata (locale TEXT)');
  db.run("INSERT INTO android_metadata VALUES ('ja_JP')");
  db.run('CREATE TABLE heatmap_table (lat INTEGER NOT NULL, lng INTEGER NOT NULL, val INTEGER, tm INTEGER, p1 INTEGER, p2 INTEGER, p3 INTEGER, p4 INTEGER, PRIMARY KEY (lat,lng))');
  db.run('CREATE INDEX latlng ON heatmap_table (lat,lng)');
  return db;
}

async function mergeAuxiliaryDatabases(targetZip, otherSource, mode) {
  const otherOuter = await JSZip.loadAsync(otherSource.bytes);
  const otherBackup = await otherOuter.file(otherSource.backupPath).async('uint8array');
  const otherZip = await JSZip.loadAsync(otherBackup.slice(HEADER_LEN));
  for (const spec of [
    { path: 'title.db', table: 'title_table', combine: false },
    { path: 'area3.db', table: 'area_table', combine: true },
  ]) {
    const targetEntry = targetZip.file(spec.path);
    const otherEntry = otherZip.file(spec.path);
    if (!otherEntry) continue;
    if (!targetEntry) {
      targetZip.file(spec.path, await otherEntry.async('uint8array'), {
        binary: true, date: otherEntry.date, compression: 'DEFLATE',
      });
      continue;
    }
    const targetDb = new SQL.Database(xorDecrypt(await targetEntry.async('uint8array')));
    const otherDb = new SQL.Database(xorDecrypt(await otherEntry.async('uint8array')));
    try {
      const columnsResult = targetDb.exec(`PRAGMA table_info(${spec.table})`);
      const columns = (columnsResult[0]?.values || []).map(row => row[1]);
      if (!columns.length) continue;
      const rows = otherDb.exec(`SELECT ${columns.join(',')} FROM ${spec.table}`)[0]?.values || [];
      const placeholders = columns.map(() => '?').join(',');
      const insert = targetDb.prepare(`INSERT INTO ${spec.table}(${columns.join(',')}) VALUES(${placeholders})`);
      const find = targetDb.prepare(`SELECT ${columns.join(',')} FROM ${spec.table} WHERE ${columns[0]}=?`);
      const update = spec.combine
        ? targetDb.prepare(`UPDATE ${spec.table} SET ${columns.slice(1).map(column => `${column}=?`).join(',')} WHERE ${columns[0]}=?`)
        : null;
      targetDb.run('BEGIN TRANSACTION');
      try {
        for (const row of rows) {
          find.bind([row[0]]);
          const exists = find.step();
          const current = exists ? find.get() : null;
          find.reset();
          if (!current) {
            insert.run(row);
          } else if (spec.combine) {
            const combined = row.slice(1).map((value, index) => {
              const oldValue = current[index + 1];
              if (typeof value !== 'number' || typeof oldValue !== 'number') return oldValue ?? value;
              return mode === 'sum' ? oldValue + value : Math.max(oldValue, value);
            });
            update.run([...combined, row[0]]);
          }
        }
        targetDb.run('COMMIT');
      } catch (error) {
        try { targetDb.run('ROLLBACK'); } catch (_) { /* no-op */ }
        throw error;
      } finally {
        insert.free(); find.free(); update?.free();
      }
      targetZip.file(spec.path, xorDecrypt(targetDb.export()), {
        binary: true, date: targetEntry.date, compression: 'DEFLATE',
      });
    } finally {
      targetDb.close(); otherDb.close();
    }
  }
}

function addMergeDelta(groups, zoom, row, deltaVal, templateRow = null) {
  if (deltaVal <= 0) return;
  const divisor = Math.pow(2, 16 - zoom);
  const lat = Math.floor(row.lat / divisor);
  const lng = Math.floor(row.lng / divisor);
  const path = `hm_${zoom}_${Math.floor(lat / 1000)}_${Math.floor(lng / 1000)}.db`;
  if (!groups.has(path)) groups.set(path, { zoom, rows: new Map() });
  const key = mergeRowKey(lat, lng);
  const current = groups.get(path).rows.get(key);
  const first = mergeRowFirst(row);
  if (current) {
    current.delta += deltaVal;
    current.first = current.first && first ? Math.min(current.first, first) : current.first || first;
    current.last = Math.max(current.last, row.tm || 0);
  } else {
    groups.get(path).rows.set(key, {
      lat, lng, delta: deltaVal, first, last: row.tm || 0,
      p2: zoom === 16 ? Math.max(0, (row.p2 || 0) - (templateRow?.p2 || 0)) : 0,
      p3: zoom === 16 ? Math.max(0, (row.p3 || 0) - (templateRow?.p3 || 0)) : 0,
      p4: zoom === 16 ? Math.max(0, (row.p4 || 0) - (templateRow?.p4 || 0)) : 0,
    });
  }
}

async function exportMergedMapping(option) {
  if (!mergeAnalysis || mergeBusy) return;
  mergeBusy = true;
  const progress = $('merge-progress');
  progress.classList.remove('hidden');
  progress.textContent = '新しいバックアップを作成しています…';
  try {
    const templateIndex = chooseMergeTemplate(mergeAnalysis, option);
    const template = mergeAnalysis.sources[templateIndex];
    if (option.mode === 'preserve') {
      const filename = exportFilename();
      const output = new Blob([template.bytes], { type: 'application/octet-stream' });
      downloadBlob(output, filename);
      closeInfoModal();
      await processFile(new File([output], filename, { type: 'application/octet-stream' }));
      setStatus(`${filename} を保存し、マージ後の地図を表示しています`);
      showToast('マージ後の地図へ切り替えました');
      return;
    }
    const other = mergeAnalysis.sources[1 - templateIndex];
    const groups = new Map();
    let changed = 0;
    for (const [key, otherRow] of other.cells) {
      const templateRow = template.cells.get(key);
      const merged = combinedMergeRow(templateRow, otherRow, option.mode);
      const delta = merged.val - (templateRow?.val || 0);
      if (delta <= 0) continue;
      changed++;
      for (let zoom = 2; zoom <= 16; zoom++) addMergeDelta(groups, zoom, merged, delta, templateRow);
      if (changed % 10000 === 0) {
        progress.textContent = `差分を準備しています… ${changed.toLocaleString()}セル`;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }

    const outer = await JSZip.loadAsync(template.bytes);
    const backupEntry = outer.file(template.backupPath);
    const backupBytes = await backupEntry.async('uint8array');
    const zip = await JSZip.loadAsync(backupBytes.slice(HEADER_LEN));
    let completed = 0;
    for (const [path, group] of groups) {
      const entry = zip.file(path);
      const db = entry
        ? new SQL.Database(xorDecrypt(await entry.async('uint8array')))
        : createHeatmapDatabase();
      try {
        db.run('BEGIN TRANSACTION');
        const select = db.prepare('SELECT val,tm,p1,p2,p3,p4 FROM heatmap_table WHERE lat=? AND lng=?');
        const update = db.prepare('UPDATE heatmap_table SET val=?,tm=?,p1=?,p2=?,p3=?,p4=? WHERE lat=? AND lng=?');
        const insert = db.prepare('INSERT INTO heatmap_table(lat,lng,val,tm,p1,p2,p3,p4) VALUES(?,?,?,?,?,?,?,?)');
        try {
          for (const delta of group.rows.values()) {
            select.bind([delta.lat, delta.lng]);
            const exists = select.step();
            const old = exists ? select.get() : null;
            select.reset();
            if (old) {
              const val = Number(old[0]) + delta.delta;
              const oldFirst = Number(old[2]) || Number(old[1]) || 0;
              const first = oldFirst && delta.first ? Math.min(oldFirst, delta.first) : oldFirst || delta.first;
              update.run([val, Math.max(Number(old[1]) || 0, delta.last), val > 1 ? first : 0,
                (Number(old[3]) || 0) + delta.p2, (Number(old[4]) || 0) + delta.p3,
                (Number(old[5]) || 0) + delta.p4, delta.lat, delta.lng]);
            } else {
              insert.run([delta.lat, delta.lng, delta.delta, delta.last, delta.delta > 1 ? delta.first : 0,
                delta.p2, delta.p3, delta.p4]);
            }
          }
        } finally { select.free(); update.free(); insert.free(); }
        db.run('COMMIT');
        zip.file(path, xorDecrypt(db.export()), {
          binary: true, date: entry?.date || new Date(), compression: 'DEFLATE',
        });
      } catch (error) {
        try { db.run('ROLLBACK'); } catch (_) { /* no-op */ }
        throw error;
      } finally { db.close(); }
      completed++;
      if (completed % 12 === 0) {
        progress.textContent = `全ズームへ反映しています… ${Math.round(completed / groups.size * 100)}%`;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }
    progress.textContent = '日付ごとの補助情報をまとめています…';
    await mergeAuxiliaryDatabases(zip, other, option.mode);
    const innerBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const rebuilt = new Uint8Array(HEADER_LEN + innerBytes.length);
    rebuilt.set(backupBytes.slice(0, HEADER_LEN));
    rebuilt.set(innerBytes, HEADER_LEN);
    outer.file(template.backupPath, rebuilt, { binary: true, date: backupEntry.date, compression: 'DEFLATE', createFolders: false });
    const output = await outer.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const filename = exportFilename();
    downloadBlob(output, filename);
    closeInfoModal();
    await processFile(new File([output], filename, { type: 'application/octet-stream' }));
    setStatus(`${filename} を保存し、マージ後の地図を表示しています`);
    showToast('マージ後の地図へ切り替えました');
  } catch (error) {
    console.error(error);
    progress.textContent = `保存できませんでした: ${error.message}`;
  } finally {
    mergeBusy = false;
  }
}

function selectMergeOption(option) {
  if (option.mode === 'preview') {
    startMergePreview();
  } else {
    exportMergedMapping(option);
  }
}

function redrawMergePreview() {
  if (!mergePreviewActive || !mergePreviewCtx || !map) return;
  const canvasElement = mergePreviewCanvas;
  mergePreviewCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const size = Math.max(2, map.getZoomScale(zoom, 16) * 3);
  const colors = { a: 'rgba(32,164,100,.7)', b: 'rgba(142,91,217,.7)', different: 'rgba(255,138,33,.72)' };
  for (const difference of mergeAnalysis.differences) {
    const row = difference.row;
    const lat = (row.lat + 0.5) / K - 90;
    const lng = (row.lng + 0.5) / K - 180;
    if (!bounds.contains([lat, lng])) continue;
    const point = map.latLngToContainerPoint([lat, lng]);
    mergePreviewCtx.fillStyle = colors[difference.kind];
    mergePreviewCtx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
  }
}

function scheduleMergePreviewRedraw() {
  if (!mergePreviewActive || mergePreviewFrame) return;
  mergePreviewFrame = requestAnimationFrame(() => {
    mergePreviewFrame = null;
    redrawMergePreview();
  });
}

function startMergePreview() {
  if (!mergeAnalysis) return;
  closeInfoModal();
  $('upload-overlay').classList.add('hidden');
  $('status-bar').classList.add('hidden');
  $('edit-toolbar').classList.add('hidden');
  canvas.style.display = 'none';
  mergePreviewActive = true;
  mergePreviewCanvas.classList.remove('hidden');
  $('merge-preview-panel').classList.remove('hidden');
  const choices = mergeOptions(mergeAnalysis).filter(option => option.mode !== 'preview');
  const actions = $('merge-preview-actions');
  actions.innerHTML = choices.map((option, index) => `<button type="button" data-preview-choice="${index}">${option.title}</button>`).join('');
  actions.querySelectorAll('[data-preview-choice]').forEach(button => {
    button.addEventListener('click', () => {
      stopMergePreview(true);
      exportMergedMapping(choices[Number(button.dataset.previewChoice)]);
    });
  });
  const rows = mergeAnalysis.differences.map(item => item.row);
  if (rows.length) {
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const row of rows) {
      south = Math.min(south, row.lat / K - 90);
      north = Math.max(north, (row.lat + 1) / K - 90);
      west = Math.min(west, row.lng / K - 180);
      east = Math.max(east, (row.lng + 1) / K - 180);
    }
    map.fitBounds([[south, west], [north, east]], { padding: [42, 42], maxZoom: 16, animate: false });
  }
  redrawMergePreview();
}

function stopMergePreview(reopen = true) {
  mergePreviewActive = false;
  mergePreviewCanvas?.classList.add('hidden');
  $('merge-preview-panel').classList.add('hidden');
  canvas.style.display = '';
  $('upload-overlay').classList.add('hidden');
  $('status-bar').classList.remove('hidden');
  $('edit-toolbar').classList.remove('hidden');
  if (reopen) openInfoModal('merge', $('merge-open'));
}

// ========================= ファイル処理 =========================

async function processFile(file) {
  $('upload-overlay').classList.add('hidden');
  $('status-bar').classList.remove('hidden');
  setStatus('ファイルを読み込み中...');
  setProgress(5);

  updateGeneration++;
  resetEdits();
  resetInsights();
  tileCache.clear(); loadingTasks.clear(); totalCells = 0; innerZip = null;
  sourceFileBytes = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateCount();

  try {
    const buf = await file.arrayBuffer();
    sourceFileBytes = buf.slice(0);
    sourceFileName = file.name || '';
    setProgress(20);

    const outer = await JSZip.loadAsync(buf);
    setProgress(35);

    let backupEntry = null;
    outer.forEach((p, e) => { if (p.endsWith('.backup')) backupEntry = e; });
    if (!backupEntry) throw new Error('.backup が見つかりません');

    const backupBuf = await backupEntry.async('uint8array');
    setProgress(55);

    if (!new TextDecoder().decode(backupBuf.slice(0, 18)).startsWith('MyAllTracksBackup'))
      throw new Error('未対応フォーマット');

    innerZip = await JSZip.loadAsync(backupBuf.slice(HEADER_LEN));
    $('edit-toolbar').classList.remove('hidden');
    updateEditUI();
    setProgress(80);

    // ズーム別タイル数を集計
    const counts = {};
    innerZip.forEach(p => {
      const m = p.match(/^hm_(\d+)_\d+_\d+\.db$/);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    });
    const summary = Object.entries(counts)
      .sort(([a], [b]) => +a - +b)
      .map(([z, n]) => `z${z}:${n}`)
      .join(' ');
    setStatus(`準備完了 [${summary}]`);
    setProgress(100);

    await doUpdate();
    prepareInsights().catch(error => {
      console.error(error);
      insightsLoading = false;
      $('insights-loading').textContent = '集計に失敗しました';
    });
  } catch (e) {
    setStatus(`エラー: ${e.message}`);
    console.error(e);
  }
}

// ========================= 初期化 =========================

async function init() {
  initUpdateBadge();

  map = L.map('map', {
    center: [35.68, 139.80],
    zoom: 13,
    inertia: false, // ドラッグ終了後の慣性パンで Canvas が遅れるのを防ぐ
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  // Canvas を Leaflet コンテナに直接追加（パンのCSS変形から独立）
  const container = map.getContainer();
  canvas = document.createElement('canvas');
  L.DomUtil.addClass(canvas, 'leaflet-zoom-animated');
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:400;';
  container.appendChild(canvas);
  ctx = canvas.getContext('2d');
  mergePreviewCanvas = document.createElement('canvas');
  mergePreviewCanvas.className = 'hidden';
  mergePreviewCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:410;';
  container.appendChild(mergePreviewCanvas);
  mergePreviewCtx = mergePreviewCanvas.getContext('2d');

  // 消しゴム選択中だけ Canvas がポインター入力を受け取る。
  let lastBrushPoint = null;
  const eventPoint = event => {
    const rect = container.getBoundingClientRect();
    return L.point(event.clientX - rect.left, event.clientY - rect.top);
  };
  const moveBrushCursor = event => {
    if (!eraserActive) return;
    const cursor = $('brush-cursor');
    cursor.style.display = 'block';
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
  };
  canvas.addEventListener('pointerenter', moveBrushCursor);
  canvas.addEventListener('pointermove', event => {
    moveBrushCursor(event);
    if (!activeStroke || !(event.buttons & 1)) return;
    const point = eventPoint(event);
    queueBrushSegment(lastBrushPoint, point);
    lastBrushPoint = point;
  });
  canvas.addEventListener('pointerleave', () => {
    if (!activeStroke) $('brush-cursor').style.display = 'none';
  });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !eraserActive) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.setPointerCapture(event.pointerId);
    activeStroke = new Map();
    lastBrushPoint = eventPoint(event);
    queueBrushPoint(lastBrushPoint);
  });
  const endPointerStroke = event => {
    if (!activeStroke) return;
    event.preventDefault();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    lastBrushPoint = null;
    finishStroke();
  };
  canvas.addEventListener('pointerup', endPointerStroke);
  canvas.addEventListener('pointercancel', endPointerStroke);

  // ─── パン ───────────────────────────────────────────
  // 通常のパンは move 毎に再描画する。ランキングからの近距離移動だけは、
  // 描画済み Canvas を背景地図と同じ量だけ移動し、終了時に一度だけ再描画する。
  let rafId = null;

  map.on('move', () => {
    if (mergePreviewActive) scheduleMergePreviewRedraw();
    if (isZooming) return;        // ズームアニメーション中はスキップ
    if (rankingPanSync) {
      const point = map.latLngToContainerPoint(rankingPanSync.anchor);
      const offset = point.subtract(rankingPanSync.origin);
      canvas.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
      return;
    }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => { rafId = null; redraw(); });
  });

  map.on('moveend', () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (rankingPanSync) {
      rankingPanSync = null;
      canvas.style.transition = 'none';
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
    }
    redraw();          // キャッシュ済みタイルで即時描画
    void canvas.offsetWidth;
    canvas.style.transition = '';
    scheduleUpdate();  // 不足タイルの非同期ロード
    if (mergePreviewActive) redrawMergePreview();
  });

  // 通常モードでセルをクリックすると、そのセルに保存された訪問情報を表示する。
  map.on('movestart', closeCellInfo);
  map.on('click', event => showCellInfo(event.latlng).catch(console.error));

  // ─── ズーム ──────────────────────────────────────────
  // Canvas はパンの二重変形を避けるため mapPane の外にある。
  // そのままでは Leaflet のズーム用 transition が適用されないため、
  // ズーム中だけコンテナにも同じ状態クラスを付ける。
  map.on('zoomstart', () => {
    // 連続操作では前の非同期更新・遅延更新を次のアニメーションへ持ち越さない。
    updateGeneration++;
    clearTimeout(updateTimer);
    if (rankingPanSync) {
      rankingPanSync = null;
      canvas.style.transition = 'none';
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
      redraw();
    }

    if (!isZooming) {
      // 直前のズーム終了と同一フレームでも、必ず identity から開始させる。
      canvas.style.transition = 'none';
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
      void canvas.offsetWidth; // transform のリセットを確定
      canvas.style.transition = '';
    }

    isZooming = true;
    L.DomUtil.addClass(container, 'leaflet-zoom-anim');
  });

  // ズームアニメーション中は、Leaflet が背景タイルに適用するのと
  // 同じ倍率・移動量を Canvas にも CSS transform で適用する。
  // zoomanim のイベントには scale が含まれないため、対象 zoom から求める。
  map.on('zoomanim', e => {
    isZooming = true;

    const scale = map.getZoomScale(e.zoom, map.getZoom());
    const halfSize = map.getSize().divideBy(2);

    // 現在の地図中心が、ズーム後の画面上で来る位置を求める。
    // マウス位置を中心とするズームでは e.center が動くため、scale だけでなく
    // この平行移動も入れないと背景地図と Canvas がずれる。
    const currentCenterAtNewZoom = map.project(map.getCenter(), e.zoom);
    const targetCenterAtNewZoom = map.project(e.center, e.zoom);
    const currentCenterNewPos = currentCenterAtNewZoom
      .subtract(targetCenterAtNewZoom)
      .add(halfSize);
    const offset = currentCenterNewPos.subtract(halfSize.multiplyBy(scale));

    canvas.style.transformOrigin = '0 0';
    L.DomUtil.setTransform(canvas, offset, scale);
  });

  map.on('zoomend', () => {
    isZooming = false;
    L.DomUtil.removeClass(container, 'leaflet-zoom-anim');

    // 次のズームがすぐ始まっても、前の transform の戻りが
    // transition されないように即時リセットする。
    canvas.style.transition = 'none';
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    redraw();
    void canvas.offsetWidth;
    canvas.style.transition = '';
    if (eraserActive && currentAppZoom() < MIN_EDIT_ZOOM) {
      setEraserActive(false);
      showToast(`Zoom ${MIN_EDIT_ZOOM}未満では編集できないため、移動に戻しました`);
    }
    updateEditUI();
    if (mergePreviewActive) redrawMergePreview();
    // 不足タイルの読込は後続の moveend で debounce して開始する。
  });

  // コンテナリサイズ対応
  new ResizeObserver(() => {
    canvas.width  = container.offsetWidth;
    canvas.height = container.offsetHeight;
    mergePreviewCanvas.width = container.offsetWidth;
    mergePreviewCanvas.height = container.offsetHeight;
    redraw();
    redrawMergePreview();
    positionCellInfo();
  }).observe(container);

  // sql.js 初期化
  try {
    SQL = await initSqlJs({
      locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`,
    });
  } catch (e) {
    alert('sql.js 読み込み失敗: ' + e.message);
    return;
  }

  // ファイル選択
  const fileInput = $('file-input');
  const returnToHome = () => {
    setToolbarMenuOpen(false);
    resetEdits();
    resetInsights();
    $('edit-toolbar').classList.add('hidden');
    $('status-bar').classList.add('hidden');
    $('upload-overlay').classList.remove('hidden');
    sourceFileBytes = null;
    sourceFileName = '';
    fileInput.value = '';
  };

  $('cell-popup-close').addEventListener('click', closeCellInfo);
  $('insights-btn').addEventListener('click', () => {
    setInsightsPanelOpen($('insights-panel').classList.contains('hidden'));
  });
  $('insights-close').addEventListener('click', () => {
    setInsightsPanelOpen(false);
    $('insights-btn').focus();
  });
  $('date-filter-btn').addEventListener('click', () => {
    setDateFilterPanelOpen($('date-filter-panel').classList.contains('hidden'));
  });
  $('date-filter-apply').addEventListener('click', applyDateFilter);
  $('date-filter-clear').addEventListener('click', clearDateFilter);
  document.addEventListener('pointerdown', event => {
    const panel = $('date-filter-panel');
    if (!panel.classList.contains('hidden') &&
        !panel.contains(event.target) && !$('date-filter-btn').contains(event.target)) {
      setDateFilterPanelOpen(false);
    }
    const toolbarMenu = $('toolbar-overflow-menu');
    if (!toolbarMenu.classList.contains('hidden') &&
        !toolbarMenu.contains(event.target) && !$('toolbar-menu-btn').contains(event.target)) {
      setToolbarMenuOpen(false);
    }
  });

  // 使い方・このツールについて
  document.querySelectorAll('[data-modal-target]').forEach(button => {
    button.addEventListener('click', () => openInfoModal(button.dataset.modalTarget, button));
  });
  document.querySelectorAll('[data-modal-close]').forEach(button => {
    button.addEventListener('click', closeInfoModal);
  });
  $('modal-backdrop').addEventListener('pointerdown', event => {
    if (event.target === $('modal-backdrop')) closeInfoModal();
  });

  const smartphoneLayout = window.matchMedia('(max-width: 767px) and (pointer: coarse)').matches;
  if (smartphoneLayout) {
    try {
      if (!sessionStorage.getItem('mapping-mobile-notice')) {
        sessionStorage.setItem('mapping-mobile-notice', 'shown');
        openInfoModal('mobile');
      }
    } catch (_) {
      openInfoModal('mobile');
    }
  }

  $('upload-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) processFile(e.target.files[0]);
  });

  $('merge-open').addEventListener('click', event => openMergeModal(event.currentTarget));
  $('menu-merge').addEventListener('click', event => openMergeModal(event.currentTarget));
  $('toolbar-menu-btn').addEventListener('click', () => {
    setToolbarMenuOpen($('toolbar-overflow-menu').classList.contains('hidden'));
  });
  $('menu-insights').addEventListener('click', () => {
    setToolbarMenuOpen(false);
    setInsightsPanelOpen(true);
  });
  $('menu-eraser').addEventListener('click', () => {
    setToolbarMenuOpen(false);
    setEraserActive(!eraserActive);
  });
  $('menu-usage').addEventListener('click', event => {
    setToolbarMenuOpen(false);
    openInfoModal('usage', event.currentTarget);
  });
  $('menu-about').addEventListener('click', event => {
    setToolbarMenuOpen(false);
    openInfoModal('about', event.currentTarget);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) setToolbarMenuOpen(false);
  });
  const mergeInput = $('merge-file-b');
  $('merge-file-b-button').addEventListener('click', () => mergeInput.click());
  mergeInput.addEventListener('change', () => {
    mergeFiles[1] = mergeInput.files[0] || null;
    $('merge-file-b-name').textContent = mergeFiles[1]?.name || '未選択';
    mergeAnalysis = null;
    $('merge-result').classList.add('hidden');
    $('merge-progress').classList.add('hidden');
    $('merge-analyze').disabled = !(mergeFiles[0] && mergeFiles[1]) || mergeBusy;
  });
  $('merge-analyze').addEventListener('click', analyzeSelectedMergeFiles);
  $('merge-preview-back').addEventListener('click', () => stopMergePreview(true));

  // ドラッグ＆ドロップ
  const card    = $('upload-card');
  const overlay = $('upload-overlay');
  overlay.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
  overlay.addEventListener('dragleave', e => {
    if (!overlay.contains(e.relatedTarget)) card.classList.remove('drag-over');
  });
  overlay.addEventListener('drop', e => {
    e.preventDefault(); card.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  });

  $('eraser-btn').addEventListener('click', () => setEraserActive(!eraserActive));
  $('undo-btn').addEventListener('click', undoEdit);
  $('redo-btn').addEventListener('click', redoEdit);
  $('save-btn').addEventListener('click', exportEditedMapping);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('toolbar-overflow-menu').classList.contains('hidden')) {
      event.preventDefault();
      setToolbarMenuOpen(false);
      $('toolbar-menu-btn').focus();
      return;
    }
    if (event.key === 'Escape' && !$('insights-panel').classList.contains('hidden')) {
      event.preventDefault();
      setInsightsPanelOpen(false);
      $('insights-btn').focus();
      return;
    }
    if (event.key === 'Escape' && !$('date-filter-panel').classList.contains('hidden')) {
      event.preventDefault();
      setDateFilterPanelOpen(false);
      $('date-filter-btn').focus();
      return;
    }
    if (event.key === 'Escape' && !$('modal-backdrop').classList.contains('hidden')) {
      event.preventDefault();
      closeInfoModal();
      return;
    }
    if (event.key === 'Escape' && !$('cell-popup').classList.contains('hidden')) {
      event.preventDefault();
      closeCellInfo();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' && eraserActive) setEraserActive(false);
    if (!sourceFileBytes || event.target.matches('input, textarea')) return;
    if (event.key.toLowerCase() === 'e' && !mod) {
      event.preventDefault();
      setEraserActive(!eraserActive);
    } else if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoEdit(); else undoEdit();
    }
  });

  $('reload-btn').addEventListener('click', returnToHome);
  $('menu-reload').addEventListener('click', returnToHome);

}

init().catch(console.error);
