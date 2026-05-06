/**
 * app.js — NEW ULPC Viewer 진입점
 */
import { loadIndex, detectProjects } from './data/loader.js';
import { state, addChangeListener } from './state.js';
import { renderTree, collapseAll } from './ui/tree.js';
import { initSearch } from './ui/search.js';
import { renderSelectedPanel } from './ui/colorPicker.js';
import { initAnimControls, refreshAnimButtons } from './ui/animControls.js';
import { initAnimation, startAnimation } from './canvas/animation.js';
import { buildCharacterSheet, renderCharacter, clearSwapCache } from './canvas/renderer.js';
import { initDownload } from './canvas/download.js';
import { initImport } from './canvas/import.js';
import { resetFrame } from './canvas/animation.js';

// ── 공유 index.json 경로 (모든 프로젝트가 하나의 index.json을 공유)
const SHARED_INDEX_URL = '../spritesheets/index.json';
const SHARED_IMAGE_BASE = '../spritesheets/';

// 런타임에 감지된 프로젝트 목록
let PROJECTS = [];

// ── 프로젝트 셀렉트 박스 초기화 ──────────────────────────────────────────────────
function initProjectSelector(projects, onProjectChange) {
  const select = document.getElementById('project-select');
  if (!select) return;

  select.innerHTML = '';
  for (const proj of projects) {
    const opt = document.createElement('option');
    opt.value = proj.id;
    opt.textContent = proj.label;
    if (proj.id === state.selectedProject) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    const projectId = select.value;
    if (projectId !== state.selectedProject) {
      onProjectChange(projectId);
    }
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

  const treeContainer = document.getElementById('tree-container');
  if (treeContainer) {
    treeContainer.innerHTML =
      '<div class="text-center text-secondary py-5">' +
      '<div class="spinner-border spinner-border-sm me-2"></div>Loading index.json…</div>';
  }

  const { tree, itemMap, palettes, files, totalFiles, pathPrefix } = await loadIndex(SHARED_INDEX_URL, projectId);

  state.tree       = tree;
  state.itemMap    = itemMap;
  state.palettes   = palettes;
  state.files      = files;
  state.pathPrefix = pathPrefix;
  state.imageBase  = SHARED_IMAGE_BASE;

  // credits.json 로드
  try {
    const creditsUrl = SHARED_IMAGE_BASE + projectId + '/credits.json';
    const cr = await fetch(creditsUrl);
    state.credits = cr.ok ? await cr.json() : null;
  } catch { state.credits = null; }
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
    // 1. index.json에서 프로젝트 자동 감지
    PROJECTS = await detectProjects(SHARED_INDEX_URL);
    if (PROJECTS.length === 0) throw new Error('index.json에 프로젝트가 없습니다.');

    // 초기 선택: 저장된 프로젝트가 없거나 목록에 없으면 첫 번째 사용
    if (!PROJECTS.find(p => p.id === state.selectedProject)) {
      state.selectedProject = PROJECTS[0].id;
    }

    // 2. 프로젝트 셀렉터 초기화
    initProjectSelector(PROJECTS, async (projectId) => {
      try {
        await loadProject(projectId);
      } catch (err) {
        console.error('Project load failed:', err);
        if (statusEl) statusEl.textContent = `Error: ${err.message}`;
      }
    });

    // 3. 기본 프로젝트 로드
    await loadProject(state.selectedProject);

    // 4. UI 초기화
    initSearch();
    initAnimControls();
    initDownload();
    initImport(loadProject);

    // resBase 기본값: 현재 viewer URL 기준 ../spritesheets/ 절대 URL
    const resBaseEl = document.getElementById('input-res-base');
    if (resBaseEl && !resBaseEl.value) {
      resBaseEl.value = new URL('../spritesheets/', window.location.href).href;
    }

    // 5. Canvas + 애니메이션 루프 초기화
    canvas = document.getElementById('preview-canvas');
    initAnimation(canvas, (frame) => {
      const el = document.getElementById('frame-indicator');
      if (el) el.textContent = frame;
    });
    startAnimation();

    // 6. 선택 변경 시 패널 + 캔버스 갱신 (buildCharacterSheet → renderCharacter)
    addChangeListener(async () => {
      refreshAnimButtons();
      renderSelectedPanel();
      await buildCharacterSheet();
      renderCharacter(canvas.getContext('2d'), state.currentFrame);
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

  } catch (err) {
    console.error('Init failed:', err);
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    document.getElementById('tree-container').innerHTML =
      `<div class="alert alert-danger m-2">Failed to load index.json: ${err.message}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
