/**
 * app.js — NEW ULPC Viewer 진입점
 */
import { loadIndex } from './data/loader.js';
import { state, addChangeListener } from './state.js';
import { renderTree, collapseAll } from './ui/tree.js';
import { initSearch } from './ui/search.js';
import { renderSelectedPanel } from './ui/colorPicker.js';
import { initAnimControls, refreshAnimButtons } from './ui/animControls.js';
import { initAnimation, startAnimation } from './canvas/animation.js';
import { buildCharacterSheet, renderCharacter, clearSwapCache, clearImageCache } from './canvas/renderer.js';
import { initDownload } from './canvas/download.js';
import { initImport } from './canvas/import.js';
import { initPresets } from './canvas/presets.js';
import { resetFrame } from './canvas/animation.js';
import { clearZipBlobs, loadFromZip, loadFromZipFile } from './data/zip-loader.js';

// ── 프로젝트 목록 (상수)
const PROJECTS = [
  { id: 'ULPC',           label: 'ULPC' },
  { id: 'NinjaAdventure', label: 'Ninja Adventure' },
];

// ── 동적으로 추가된 ZIP 프로젝트 (로컬 파일 선택, 새로고침하면 초기화)
// key: projectId (파일명 without .zip), value: File 객체
const dynamicProjects = new Map();

// ── 프로젝트 셀렉트 박스 초기화 ──────────────────────────────────────────────────
function initProjectSelector(onProjectChange) {
  const select = document.getElementById('project-select');
  if (!select) return;

  // 빈 기본 옵션 (선택 안 된 상태)
  const empty = document.createElement('option');
  empty.value    = '';
  empty.textContent = '— Select project —';
  empty.selected = true;
  empty.disabled = true;
  select.appendChild(empty);

  for (const proj of PROJECTS) {
    const opt = document.createElement('option');
    opt.value = proj.id;
    opt.textContent = proj.label;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    const projectId = select.value;
    if (projectId) onProjectChange(projectId);
  });
}

// ── 프로젝트 데이터 로드 ──────────────────────────────────────────────────────────
let canvas = null;

async function loadProject(projectId) {
  const statusEl = document.getElementById('status-text');
  if (statusEl) statusEl.textContent = `Loading ${projectId}…`;

  state.selections      = {};
  state.expandedNodes   = {};
  state.selectedProject = projectId;
  clearSwapCache();
  clearImageCache();
  clearZipBlobs();

  const treeContainer = document.getElementById('tree-container');
  if (treeContainer) {
    treeContainer.innerHTML =
      '<div class="text-center text-secondary py-5">' +
      '<div class="spinner-border spinner-border-sm me-2"></div>Loading…</div>';
  }

  const dynFile = dynamicProjects.get(projectId);
  const proj    = PROJECTS.find(p => p.id === projectId);
  let result;

  if (dynFile) {
    // 로컬 파일로 추가된 ZIP 프로젝트
    if (statusEl) statusEl.textContent = `Loading ${projectId}.zip…`;
    result = await loadFromZipFile(dynFile);
    state.imageBase = '';
  } else if (proj?.zip) {
    // 서버 경로 ZIP 프로젝트
    if (statusEl) statusEl.textContent = `Downloading ${projectId}.zip…`;
    result = await loadFromZip(`../spritesheets/${projectId}.zip`);
    state.imageBase = '';
  } else {
    const indexUrl = `../spritesheets/${projectId}/index.json`;
    result = await loadIndex(indexUrl);
    state.imageBase = `../spritesheets/${projectId}/`;
  }

  const { tree, itemMap, palettes, files, totalFiles } = result;
  state.tree       = tree;
  state.itemMap    = itemMap;
  state.palettes   = palettes;
  state.files      = files;
  state.pathPrefix = '';

  // credits.json 로드 (ZIP이면 zip 내부에서, 아니면 HTTP)
  if (result.credits !== undefined) {
    state.credits = result.credits;
  } else {
    try {
      const creditsUrl = `../spritesheets/${projectId}/credits.json`;
      const cr = await fetch(creditsUrl);
      state.credits = cr.ok ? await cr.json() : null;
    } catch { state.credits = null; }
  }
  renderCredits();

  if (statusEl) statusEl.textContent = `${totalFiles.toLocaleString()} files`;

  renderTree();
  renderSelectedPanel();
}

function renderCredits() {
  const el = document.getElementById('credits-list');
  if (!el) return;
  const credits = state.credits;
  if (!credits) {
    el.innerHTML = '<p class="text-secondary small mb-0">No credits available.</p>';
    return;
  }
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const parts = [];
  if (credits.Authors?.length) {
    parts.push('<p class="mb-1 fw-semibold" style="font-size:0.72rem">Authors</p><ul class="mb-2 ps-3" style="font-size:0.72rem">');
    for (const a of credits.Authors) {
      parts.push(a.url
        ? `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a></li>`
        : `<li>${esc(a.name)}</li>`);
    }
    parts.push('</ul>');
  }
  if (credits.Licenses?.length) {
    parts.push('<p class="mb-1 fw-semibold" style="font-size:0.72rem">License</p><ul class="mb-2 ps-3" style="font-size:0.72rem">');
    for (const l of credits.Licenses) parts.push(`<li>${esc(l)}</li>`);
    parts.push('</ul>');
  }
  if (credits.URLs?.length) {
    parts.push('<p class="mb-1 fw-semibold" style="font-size:0.72rem">Links</p><ul class="mb-0 ps-3" style="font-size:0.72rem">');
    for (const u of credits.URLs) {
      parts.push(`<li><a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.label)}</a></li>`);
    }
    parts.push('</ul>');
  }
  el.innerHTML = parts.join('') || '<p class="text-secondary small mb-0">No credits available.</p>';
}

function downloadCredits() {
  const credits = state.credits;
  if (!credits) return;
  const blob = new Blob([JSON.stringify(credits, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `credits_${state.selectedProject}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 초기화 ────────────────────────────────────────────────────────────────────────
async function init() {
  const statusEl = document.getElementById('status-text');

  try {
    // 1. 프로젝트 셀렉터 초기화 (상수 기반, 초기 로드 없음)
    initProjectSelector(async (projectId) => {
      try {
        await loadProject(projectId);
      } catch (err) {
        console.error('Project load failed:', err);
        if (statusEl) statusEl.textContent = `Error: ${err.message}`;
        document.getElementById('tree-container').innerHTML =
          `<div class="alert alert-danger m-2">Failed to load: ${err.message}</div>`;
      }
    });

    // 2. 초기 트리: 프로젝트 선택 안내
    document.getElementById('tree-container').innerHTML =
      '<div class="text-center text-secondary py-5 small">Select a project above.</div>';
    if (statusEl) statusEl.textContent = '';

    // 3. UI 초기화
    initSearch();
    initAnimControls();
    initDownload();
    initImport(loadProject);
    initPresets(loadProject);

    // resBase 기본값: 현재 viewer URL 기준 ../spritesheets/ 절대 URL
    const resBaseEl = document.getElementById('export-res-base');
    if (resBaseEl && !resBaseEl.value) {
      resBaseEl.value = new URL('../spritesheets/', window.location.href).href;
    }

    // 4. Canvas + 애니메이션 루프 초기화
    canvas = document.getElementById('preview-canvas');
    initAnimation(canvas, (frame) => {
      const el = document.getElementById('frame-indicator');
      if (el) el.textContent = frame;
    });
    startAnimation();

    // 6. 선택 변경 시 패널 + 캔버스 갱신 (buildCharacterSheet → renderCharacter)
    let _buildingCount = 0;
    const _loadingEl = () => document.getElementById('canvas-loading');
    addChangeListener(async () => {
      refreshAnimButtons();
      renderSelectedPanel();
      _buildingCount++;
      const el = _loadingEl();
      if (el) el.style.display = 'flex';
      await buildCharacterSheet();
      _buildingCount--;
      if (_buildingCount === 0) {
        renderCharacter(canvas.getContext('2d'), state.currentFrame);
        if (el) el.style.display = 'none';
      }
    });

    // 7. Reset All 버튼
    document.getElementById('btn-reset-all')?.addEventListener('click', () => {
      state.selections = {};
      renderSelectedPanel();
      renderTree();
    });

    // 8. Collapse All 버튼
    document.getElementById('btn-collapse-all')?.addEventListener('click', () => {
      collapseAll();
    });

    // 9. Credits 다운로드 버튼
    document.getElementById('btn-download-credits')?.addEventListener('click', downloadCredits);

    // 10. ZIP 프로젝트 추가 버튼
    const inputAddZip = document.getElementById('input-add-zip');
    document.getElementById('btn-add-project')?.addEventListener('click', () => {
      inputAddZip?.click();
    });
    inputAddZip?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // 동일 파일 재선택 허용
      if (!file) return;

      const projectId = file.name.replace(/\.zip$/i, '');
      dynamicProjects.set(projectId, file);

      // 셀렉트에 옵션 추가 (중복 방지)
      const select = document.getElementById('project-select');
      if (select && !select.querySelector(`option[value="${CSS.escape(projectId)}"]`)) {
        const opt = document.createElement('option');
        opt.value = projectId;
        opt.textContent = projectId;
        select.appendChild(opt);
      }

      // 선택 후 로드
      if (select) select.value = projectId;
      try {
        await loadProject(projectId);
      } catch (err) {
        console.error('ZIP load failed:', err);
        if (statusEl) statusEl.textContent = `Error: ${err.message}`;
        document.getElementById('tree-container').innerHTML =
          `<div class="alert alert-danger m-2">Failed to load: ${err.message}</div>`;
      }
    });

  } catch (err) {
    console.error('Init failed:', err);
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    document.getElementById('tree-container').innerHTML =
      `<div class="alert alert-danger m-2">Failed to load index.json: ${err.message}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
