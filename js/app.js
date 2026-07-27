'use strict';

// ========================= 定数 =========================

const HEADER_LEN = 24; // 'MyAllTracksBackup.v0001:'
const K = 5000;         // zoom16基準: lat_deg = internal / K - 90
const MIN_EDIT_ZOOM = 12;

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
let eraserActive = false;
let deletedCells = new Map(); // zoom16 の "lat,lng" -> 元レコード
let deletionDeltas = new Map(); // zoom -> Map("lat,lng" -> 集約削除量)
let undoStack = [];
let redoStack = [];
let activeStroke = null;
let brushQueue = Promise.resolve();
let toastTimer = null;
let lastModalTrigger = null;

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
  $('point-count').textContent = totalCells > 0
    ? `${totalCells.toLocaleString()} cells 読込済` : '';
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function openInfoModal(name, trigger = null) {
  const content = $(`modal-${name}`);
  if (!content) return;
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

function updateEditUI() {
  const z = currentAppZoom();
  const eraserBtn = $('eraser-btn');
  if (!eraserBtn) return;
  eraserBtn.classList.toggle('active', eraserActive);
  eraserBtn.classList.toggle('unavailable', z < MIN_EDIT_ZOOM);
  eraserBtn.setAttribute('aria-pressed', String(eraserActive));
  eraserBtn.title = z < MIN_EDIT_ZOOM
    ? `編集するにはZoom ${MIN_EDIT_ZOOM}以上まで拡大してください`
    : '消しゴム（E）';
  $('undo-btn').disabled = undoStack.length === 0;
  $('redo-btn').disabled = redoStack.length === 0;
  $('save-btn').disabled = deletedCells.size === 0;
  const removedRecords = [...deletedCells.values()].reduce((sum, c) => sum + (c.val || 0), 0);
  $('edit-summary').textContent = deletedCells.size
    ? `${deletedCells.size.toLocaleString()} cells · ${removedRecords.toLocaleString()} records 削除予定`
    : `編集なし · Zoom ${z}`;
}

function setEraserActive(active) {
  if (active && currentAppZoom() < MIN_EDIT_ZOOM) {
    showToast(`編集するにはZoom ${MIN_EDIT_ZOOM}以上まで拡大してください`);
    updateEditUI();
    return;
  }
  eraserActive = !!active;
  if (map) {
    if (eraserActive) map.dragging.disable();
    else map.dragging.enable();
  }
  if (canvas) canvas.style.pointerEvents = eraserActive ? 'auto' : 'none';
  if (!eraserActive) $('brush-cursor').style.display = 'none';
  updateEditUI();
}

function resetEdits() {
  setEraserActive(false);
  deletedCells.clear();
  deletionDeltas.clear();
  undoStack = [];
  redoStack = [];
  activeStroke = null;
  brushQueue = Promise.resolve();
  updateEditUI();
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
  // サイズが変わった時だけリサイズ（毎フレームのリセットでちらつき防止）
  if (canvas.width !== container.offsetWidth || canvas.height !== container.offsetHeight) {
    canvas.width  = container.offsetWidth;
    canvas.height = container.offsetHeight;
  }
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
  const bounds  = map.getBounds();
  const f       = Kz / 1000;       // タイル番号算出係数

  // 描画タイル範囲
  const aMin = Math.floor((bounds.getSouth() + 90)  * f);
  const aMax = Math.floor((bounds.getNorth() + 90)  * f);
  const bMin = Math.floor((bounds.getWest()  + 180) * f);
  const bMax = Math.floor((bounds.getEast()  + 180) * f);

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
      xCache.set(lng_i, map.latLngToContainerPoint(L.latLng(center.lat, lng)).x);
    }
    return xCache.get(lng_i);
  }

  function gridY(lat_i) {
    if (!yCache.has(lat_i)) {
      const lat = lat_i / Kz - 90;
      yCache.set(lat_i, map.latLngToContainerPoint(L.latLng(lat, center.lng)).y);
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

  // alpha=0.6 で描画（背景が40%透けて見える）
  // ★ 二重合成を避けるため2パス構成:
  //    Pass1: 塗り色を直接描画（1回だけ合成 → 正しい明度）
  //    Pass2: 細いグリッドストロークを上書き
  ctx.save();
  ctx.globalAlpha = 0.6;

  // Pass1: 塗り色（フルセルサイズ）
  const drawGrid = representativeCellPxW >= 4;
  const drawnRects = drawGrid ? [] : null;
  for (let a = aMin; a <= aMax; a++) {
    for (let b = bMin; b <= bMax; b++) {
      const cells = tileCache.get(`${appZoom}_${a}_${b}`);
      if (!cells) continue;
      for (const { lat_i, lng_i, val } of cells) {
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

// ========================= ファイル処理 =========================

async function processFile(file) {
  $('upload-overlay').classList.add('hidden');
  $('status-bar').classList.remove('hidden');
  setStatus('ファイルを読み込み中...');
  setProgress(5);

  updateGeneration++;
  resetEdits();
  tileCache.clear(); loadingTasks.clear(); totalCells = 0; innerZip = null;
  sourceFileBytes = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateCount();

  try {
    const buf = await file.arrayBuffer();
    sourceFileBytes = buf.slice(0);
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
  } catch (e) {
    setStatus(`エラー: ${e.message}`);
    console.error(e);
  }
}

// ========================= 初期化 =========================

async function init() {
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
  // CSS transform によるズレを防ぐため、move 毎に直接再描画する。
  // latLngToContainerPoint が mapPane 位置を既に考慮するので
  // CSS transform との二重適用が発生しない。
  let rafId = null;

  map.on('move', () => {
    if (isZooming) return;        // ズームアニメーション中はスキップ
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => { rafId = null; redraw(); });
  });

  map.on('moveend', () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    redraw();          // キャッシュ済みタイルで即時描画
    scheduleUpdate();  // 不足タイルの非同期ロード
  });

  // ─── ズーム ──────────────────────────────────────────
  // Canvas はパンの二重変形を避けるため mapPane の外にある。
  // そのままでは Leaflet のズーム用 transition が適用されないため、
  // ズーム中だけコンテナにも同じ状態クラスを付ける。
  map.on('zoomstart', () => {
    // 連続操作では前の非同期更新・遅延更新を次のアニメーションへ持ち越さない。
    updateGeneration++;
    clearTimeout(updateTimer);

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
    // 不足タイルの読込は後続の moveend で debounce して開始する。
  });

  // コンテナリサイズ対応
  new ResizeObserver(() => {
    canvas.width  = container.offsetWidth;
    canvas.height = container.offsetHeight;
    redraw();
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
    if (event.key === 'Escape' && !$('modal-backdrop').classList.contains('hidden')) {
      event.preventDefault();
      closeInfoModal();
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

  $('reload-btn').addEventListener('click', () => {
    resetEdits();
    $('edit-toolbar').classList.add('hidden');
    $('upload-overlay').classList.remove('hidden');
    fileInput.value = '';
  });

}

init().catch(console.error);
