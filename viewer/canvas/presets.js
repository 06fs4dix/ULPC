/**
 * presets.js — 선택 조합을 localStorage에 저장하고 목록에서 즉시 불러오기
 */
import { state } from '../state.js';
import { buildExportData } from './download.js';
import { applyImportData } from './import.js';

const STORAGE_KEY = 'ulpc_viewer_presets';
let _loadProject  = null;
let _defaultPresets = null;  // 캐시

// ── localStorage 헬퍼 ────────────────────────────────────────────────────────

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function savePresets(presets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

async function loadDefaultPresets() {
  if (_defaultPresets) return _defaultPresets;
  try {
    const res = await fetch('./data/default_presets.json');
    if (res.ok) _defaultPresets = await res.json();
    else _defaultPresets = [];
  } catch { _defaultPresets = []; }
  return _defaultPresets;
}

// ── 초기화 ──────────────────────────────────────────────────────────────────

export function initPresets(loadProjectFn) {
  _loadProject = loadProjectFn;

  document.getElementById('btn-presets')
    ?.addEventListener('click', openModal);
  document.getElementById('btn-preset-save')
    ?.addEventListener('click', saveCurrent);
  document.getElementById('preset-name-input')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrent(); });
  document.getElementById('btn-preset-export')
    ?.addEventListener('click', exportPresets);
  document.getElementById('btn-preset-import')
    ?.addEventListener('click', () => document.getElementById('input-preset-import')?.click());
  document.getElementById('input-preset-import')
    ?.addEventListener('change', importPresets);
  document.getElementById('btn-preset-zip')
    ?.addEventListener('click', exportZip);
  document.getElementById('btn-preset-clear-all')
    ?.addEventListener('click', clearAllPresets);

}

// ── 모달 ────────────────────────────────────────────────────────────────────

async function openModal() {
  if (loadPresets().length === 0) {
    if (confirm('No presets yet. Load sample characters?')) {
      await loadSamples();
    }
  }
  renderList();
  // eslint-disable-next-line no-undef
  bootstrap.Modal.getOrCreateInstance(document.getElementById('presets-modal')).show();
}

function renderList() {
  const listEl = document.getElementById('presets-list');
  if (!listEl) return;
  const presets = loadPresets();

  if (presets.length === 0) {
    listEl.innerHTML = '<p class="text-secondary small text-center py-3 mb-0">No presets saved yet.</p>';
    return;
  }

  listEl.innerHTML = '';
  for (const preset of presets) {
    listEl.appendChild(_buildRow(preset, true));
  }
}

function _buildRow(preset, deletable) {
  const row = document.createElement('div');
  row.className = 'd-flex align-items-center gap-2 py-2 border-bottom';
  const parts = (preset.selections || []).length;
  row.innerHTML = `
    <div class="preset-load-area flex-grow-1" style="cursor:pointer;min-width:0">
      <div class="fw-semibold text-truncate" style="font-size:0.85rem">${_esc(preset.name)}</div>
      <div class="text-secondary" style="font-size:0.72rem">${parts} parts</div>
    </div>
    <button class="btn btn-sm btn-outline-danger preset-del py-0 px-1" title="삭제">
      <i class="bi bi-trash3"></i>
    </button>
  `;
  row.querySelector('.preset-load-area').addEventListener('click', () => applyPreset(preset));
  row.querySelector('.preset-del').addEventListener('click', e => {
    e.stopPropagation();
    deletePreset(preset.name);
  });
  return row;
}

// ── 저장 ────────────────────────────────────────────────────────────────────

function saveCurrent() {
  const input = document.getElementById('preset-name-input');
  const name  = input?.value.trim();
  if (!name) { input?.focus(); return; }
  if (!state.selectedProject || Object.keys(state.selections || {}).length === 0) {
    alert('No items selected.');
    return;
  }

  const data    = buildExportData();
  const presets = loadPresets();
  presets.unshift({ ...data, name });
  savePresets(presets);
  if (input) input.value = '';
  renderList();
}

// ── 불러오기 ─────────────────────────────────────────────────────────────────

async function applyPreset(preset) {
  // eslint-disable-next-line no-undef
  bootstrap.Modal.getInstance(document.getElementById('presets-modal'))?.hide();
  await applyImportData(preset, _loadProject);
}

// ── 삭제 ────────────────────────────────────────────────────────────────────

function deletePreset(name) {
  savePresets(loadPresets().filter(p => p.name !== name));
  renderList();
}

// ── Clear All ───────────────────────────────────────────────────────────────

function clearAllPresets() {
  if (!confirm('Delete all presets?')) return;
  savePresets([]);
  renderList();
}

// ── Samples ─────────────────────────────────────────────────────────────────

async function loadSamples() {
  const defaults = await loadDefaultPresets();
  if (defaults.length === 0) { alert('No sample presets available.'); return; }
  const existing = loadPresets();
  const existingNames = new Set(existing.map(p => p.name));
  const newOnes = defaults.filter(p => !existingNames.has(p.name));
  if (newOnes.length === 0) { alert('All samples already loaded.'); return; }
  savePresets([...existing, ...newOnes]);
  renderList();
}

// ── Export / Import / ZIP ────────────────────────────────────────────────────

function exportPresets() {
  const presets = loadPresets();
  if (presets.length === 0) { alert('No presets to export.'); return; }
  const resBase = document.getElementById('preset-res-base')?.value.trim() || '';
  const output = presets.map(p => {
    const copy = { ...p };
    if (resBase) copy.resBase = resBase;
    return copy;
  });
  const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
  _download(blob, 'ulpc_presets.json');
}

function importPresets(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data)) { alert('Invalid format: expected a JSON array.'); return; }
      // 기존 프리셋과 병합 (id 중복 제거)
      const existing = loadPresets();
      const existingNames = new Set(existing.map(p => p.name));
      const merged = [...existing, ...data.filter(p => !existingNames.has(p.name))];
      savePresets(merged);
      renderList();
    } catch (err) {
      alert(`JSON parse error: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

async function exportZip() {
  const presets = loadPresets();
  if (presets.length === 0) { alert('No presets to export.'); return; }

  const JSZip = window.JSZip;
  if (!JSZip) { alert('JSZip not available.'); return; }

  const resBase = document.getElementById('preset-res-base')?.value.trim() || '';

  const btn = document.getElementById('btn-preset-zip');
  const setLabel = (s) => { if (btn) btn.innerHTML = s; };
  if (btn) btn.disabled = true;
  setLabel('<span class="spinner-border spinner-border-sm me-1"></span>Collecting…');

  try {
    const zip = new JSZip();

    // 모든 프리셋에서 고유 파일 경로 수집 + 실제 prefix 의 icon.png
    const filePaths = new Set();
    for (const preset of presets) {
      for (const sel of preset.selections || []) {
        for (const f of sel.files || []) filePaths.add(f);
        // icon: 색상 가상 경로가 아니라 파일 기준 아이템 prefix
        const sample = (sel.files && sel.files[0]) || null;
        if (sample) {
          const segs = sample.split('/');
          const aIdx = segs.findIndex(s => /^a\[/.test(s));
          if (aIdx > 0) {
            const itemPrefix = segs.slice(0, aIdx).join('/');
            if (!state.icons || state.icons.has(itemPrefix)) {
              filePaths.add(itemPrefix + '/icon.png');
            }
          }
        }
      }
    }

    // 절대 base URL (상대경로 오류 방지)
    const baseUrl = new URL('../spritesheets/', window.location.href).href;

    let done = 0, ok = 0, fail = 0;
    const total = filePaths.size;

    // 동시 요청 제한 (브라우저 과부하 방지)
    const CONCURRENCY = 20;
    const queue = [...filePaths];

    async function worker() {
      while (queue.length > 0) {
        const filePath = queue.shift();
        const encoded = filePath.split('/').map(s =>
          s.replace(/\[/g, '%5B').replace(/\]/g, '%5D')
        ).join('/');
        try {
          const res = await fetch(baseUrl + encoded);
          if (res.ok) {
            zip.file(filePath, await res.blob());
            ok++;
          } else {
            fail++;
          }
        } catch { fail++; }
        done++;
        if (done % 20 === 0 || done === total)
          setLabel(`<span class="spinner-border spinner-border-sm me-1"></span>${ok} ok / ${done} of ${total}`);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // 각 selection을 base 경로(레이어 세그먼트 제거)로 그룹핑하여 index.json 저장
    const LAYER_SEGS = new Set(['p[behind]','p[bg]','p[fg]','p[background]','p[foreground]','p[universal]','p[universal_behind]']);
    for (const preset of presets) {
      const grouped = new Map(); // basePath → [sel, ...]
      for (const sel of preset.selections || []) {
        if (!sel.path) continue;
        // 경로 끝에서 레이어 세그먼트 제거 → base 경로
        const parts = sel.path.split('/');
        while (parts.length > 0 && LAYER_SEGS.has(parts[parts.length - 1])) parts.pop();
        const basePath = parts.join('/');
        if (!grouped.has(basePath)) grouped.set(basePath, []);
        grouped.get(basePath).push(sel);
      }
      for (const [basePath, sels] of grouped) {
        const selJson = {
          name: preset.name,
          version: preset.version ?? 3,
          selections: sels,
        };
        if (resBase) selJson.resBase = resBase;
        zip.file(basePath + '/index.json', JSON.stringify(selJson, null, 2));
      }
    }

    // 프리셋 목록도 함께 포함
    const presetsOut = presets.map(p => {
      const copy = { ...p };
      if (resBase) copy.resBase = resBase;
      return copy;
    });
    zip.file('presets.json', JSON.stringify(presetsOut, null, 2));

    setLabel('<span class="spinner-border spinner-border-sm me-1"></span>Packing…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    _download(blob, 'ulpc_presets.zip');
    console.log(`ZIP: ${ok} packed, ${fail} missing, ${total} total`);
  } finally {
    if (btn) btn.disabled = false;
    setLabel('<i class="bi bi-file-zip me-1"></i>ZIP');
  }
}

function _download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 유틸 ────────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
