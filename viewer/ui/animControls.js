/**
 * animControls.js — 애니메이션 버튼, 방향 선택, 줌, FPS
 */
import { ANIM_META, ANIM_NAMES, resetFrame } from '../canvas/animation.js';
import { state, onSelectionChange } from '../state.js';

export function initAnimControls() {
  renderAnimButtons();
  initDirectionButtons();
  initZoomSlider();
  initFpsSlider();
}

/**
 * 선택된 아이템에 실제로 존재하는 애니메이션 목록 반환.
 * 선택 없으면 전체 반환.
 */
function getAvailableAnimations() {
  const prefixes = Object.keys(state.selections || {});
  if (prefixes.length === 0 || !state.itemMap) return ANIM_NAMES;

  const available = new Set();
  for (const prefix of prefixes) {
    const files = state.itemMap[prefix] || [];
    for (const f of files) {
      const segs = f.split('/');
      const aIdx = segs.findIndex(s => /^a\[/.test(s));
      if (aIdx < 0) continue;
      const m = segs[aIdx].match(/^a\[(.+)\]$/);
      if (m) available.add(m[1]);
    }
  }

  // ULPC 표준 순서 유지, 미등록 커스텀 애니는 뒤에 추가 (wheelchair 등)
  return [
    ...ANIM_NAMES.filter(name => available.has(name)),
    ...[...available].filter(name => !ANIM_NAMES.includes(name)).sort(),
  ];
}

/** 애니메이션 버튼 목록 렌더 */
function renderAnimButtons() {
  const container = document.getElementById('anim-buttons');
  if (!container) return;
  container.innerHTML = '';

  const availableAnims = getAvailableAnimations();

  // 현재 선택된 애니메이션이 사용 불가하면 첫 번째로 전환
  if (availableAnims.length > 0 && !availableAnims.includes(state.selectedAnimation)) {
    state.selectedAnimation = availableAnims[0];
    state.currentFrame = 0;
    resetFrame();
  }

  for (const name of availableAnims) {
    const btn = document.createElement('button');
    btn.className = `btn btn-sm anim-btn ${name === state.selectedAnimation ? 'btn-primary' : 'btn-outline-secondary'}`;
    btn.textContent = name.replace(/_/g, ' ');
    btn.dataset.anim = name;
    btn.addEventListener('click', () => {
      state.selectedAnimation = name;
      state.currentFrame = 0;
      resetFrame();
      updateAnimButtons();
      updateDirectionButtons(); // hurt/climb 방향 비활성화
      onSelectionChange();
    });
    container.appendChild(btn);
  }
}

/** 선택 변경 시 외부에서 호출해 버튼 목록 갱신 */
export function refreshAnimButtons() {
  renderAnimButtons();
  updateDirectionButtons();
}

function updateAnimButtons() {
  document.querySelectorAll('#anim-buttons .anim-btn').forEach(btn => {
    const active = btn.dataset.anim === state.selectedAnimation;
    btn.className = `btn btn-sm anim-btn ${active ? 'btn-primary' : 'btn-outline-secondary'}`;
  });
}

/** 방향 버튼 */
function initDirectionButtons() {
  document.querySelectorAll('#dir-buttons .dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedDirection = parseInt(btn.dataset.dir);
      updateDirectionButtons();
      onSelectionChange();
    });
  });
  updateDirectionButtons();
}

function updateDirectionButtons() {
  const layout  = state.animLayout?.[state.selectedAnimation];
  const dirless = layout ? layout.dirCount === 1 : false;
  document.querySelectorAll('#dir-buttons .dir-btn').forEach(btn => {
    const active = parseInt(btn.dataset.dir) === state.selectedDirection;
    btn.className = `btn btn-sm dir-btn ${active ? 'btn-secondary' : 'btn-outline-secondary'}`;
    btn.disabled = dirless;
  });
}

/** 줌 슬라이더 */
function initZoomSlider() {
  const slider = document.getElementById('zoom-slider');
  const valueEl = document.getElementById('zoom-value');
  if (!slider) return;

  slider.value = state.zoomLevel;
  if (valueEl) valueEl.textContent = `${state.zoomLevel}×`;

  slider.addEventListener('input', () => {
    state.zoomLevel = parseFloat(slider.value);
    if (valueEl) valueEl.textContent = `${state.zoomLevel}×`;
    onSelectionChange();
  });
}

/** FPS 슬라이더 */
function initFpsSlider() {
  const slider = document.getElementById('fps-slider');
  const valueEl = document.getElementById('fps-indicator');
  if (!slider) return;

  slider.value = state.fps;
  if (valueEl) valueEl.textContent = state.fps;

  slider.addEventListener('input', () => {
    state.fps = parseInt(slider.value);
    if (valueEl) valueEl.textContent = state.fps;
  });
}
