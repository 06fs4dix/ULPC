/**
 * tree.js — Bootstrap 기반 재귀 폴더 트리 렌더 (lazy DOM 빌드)
 *
 * 초기 렌더에서는 카테고리 헤더만 생성하고,
 * 자식 DOM은 노드를 펼칠 때 그 시점에 생성한다 (lazy rendering).
 * leafCount는 DOM 없이 트리 데이터를 경량 순회해 계산한다.
 */
import { displayName, isLeaf, parseFilename } from '../data/loader.js';
import { state, onSelectionChange } from '../state.js';

// ── 썸네일 ──────────────────────────────────────────────────────────────────

const THUMB_SIZE = 20;
const THUMB_ANIM_PRIORITY = ['walk', 'idle', 'combat_idle', 'slash', 'thrust', 'spellcast', 'shoot'];
const _imgCache = new Map();

function _encodeFilePath(filePath) {
  return filePath.split('/').map(seg =>
    seg.replace(/\[/g, '%5B').replace(/\]/g, '%5D')
  ).join('/');
}

function _loadImage(url) {
  if (_imgCache.has(url)) {
    const img = _imgCache.get(url);
    if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
    return new Promise((resolve, reject) => {
      img.addEventListener('load', () => resolve(img), { once: true });
      img.addEventListener('error', () => reject(), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    _imgCache.set(url, img);
    img.onload  = () => resolve(img);
    img.onerror = () => { _imgCache.delete(url); reject(); };
    img.src = url;
  });
}

function _pickThumbFile(files) {
  for (const anim of THUMB_ANIM_PRIORITY) {
    const f = files.find(f => f.includes(`/a[${anim}]_`) || f.includes(`/a[${anim}]/`));
    if (f) return f;
  }
  return files[0] || null;
}

function _resolveUrl(filePath) {
  const imageBase = state.imageBase ?? '../spritesheets/';
  const encoded   = _encodeFilePath(filePath);
  return state.zipBlobs.size > 0
    ? (state.zipBlobs.get(filePath) ?? (imageBase + encoded))
    : imageBase + encoded;
}

async function _drawThumb(canvas, path) {
  const files = state.itemMap?.[path];
  if (!files || files.length === 0) return;

  // icon.png 직접 로드 시도 (인덱스 미포함, 경로 직접 구성)
  try {
    const img = await _loadImage(_resolveUrl(path + '/icon.png'));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
    return;
  } catch { /* fallback */ }

  // fallback: 기존 spritesheet UV 크롭 방식
  const file = _pickThumbFile(files);
  if (!file) return;

  const segs  = file.split('/');
  const aIdx  = segs.findIndex(s => /^a\[/.test(s));
  if (aIdx < 0) return;

  const animName = (segs[aIdx].match(/^a\[(.+?)\]/) || [])[1] || '';
  const fname    = segs[aIdx + 2];
  if (!fname) return;

  const parsed = parseFilename(fname);
  if (!parsed) return;
  const { frameSize, dirs } = parsed;

  const dirless  = dirs === '1' || animName === 'hurt' || animName === 'climb';
  const southRow = dirless ? 0 : (dirs ? Math.max(0, dirs.indexOf('1')) : 2);
  const srcY     = southRow * frameSize;

  try {
    const img = await _loadImage(_resolveUrl(file));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, srcY, frameSize, frameSize, 0, 0, THUMB_SIZE, THUMB_SIZE);
  } catch { /* 이미지 없으면 빈 상태 유지 */ }
}

let _thumbObserver = null;
function _getObserver() {
  if (_thumbObserver) return _thumbObserver;
  _thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const canvas = e.target;
      const path   = canvas.dataset.thumbPath;
      if (path) {
        _drawThumb(canvas, path);
        _thumbObserver.unobserve(canvas);
      }
    }
  }, { rootMargin: '120px' });
  return _thumbObserver;
}

function makeThumb(path) {
  const c = document.createElement('canvas');
  c.width  = THUMB_SIZE;
  c.height = THUMB_SIZE;
  c.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;` +
    'image-rendering:pixelated;border-radius:2px;flex-shrink:0;opacity:0.88;';
  c.dataset.thumbPath = path;
  _getObserver().observe(c);
  return c;
}

// ── leafCount 경량 계산 (DOM 없이 트리 데이터 순회) ────────────────────────

function countLeaves(treeNode, nodePath) {
  if (isLeaf(treeNode)) return 1;
  let count = state.itemMap?.[nodePath] ? 1 : 0;
  for (const seg of Object.keys(treeNode)) {
    count += countLeaves(treeNode[seg], `${nodePath}/${seg}`);
  }
  return count;
}

// ── 검색용 전체 강제 빌드 ────────────────────────────────────────────────────

function ensureFullBuild(container) {
  let ul = container.querySelector('ul.tree-root');
  if (!ul) ul = container;
  _buildAllPending(ul);
}

function _buildAllPending(el) {
  for (const child of el.children) {
    if (child.tagName === 'UL' && child._buildFn) {
      child._buildFn();
    }
    _buildAllPending(child);
  }
}

// ── 트리 렌더 진입점 ─────────────────────────────────────────────────────────

export function renderTree() {
  const container = document.getElementById('tree-container');
  if (!container || !state.tree) return;
  container.innerHTML = '';
  _thumbObserver = null; // 기존 observer 초기화
  _imgCache.clear();    // 썸네일 이미지 캐시 초기화 (프로젝트 전환 시 stale URL 방지)

  const ul = document.createElement('ul');
  ul.className = 'tree-root';

  const categories = Object.keys(state.tree).sort();
  for (const cat of categories) {
    ul.appendChild(buildCategoryNode(cat, state.tree[cat], cat));
  }
  container.appendChild(ul);
}

// ── 카테고리 루트 노드 ───────────────────────────────────────────────────────

function buildCategoryNode(seg, children, path) {
  const li = document.createElement('li');

  const header = document.createElement('div');
  header.className = 'tree-node-toggle d-flex align-items-center gap-1 py-1';
  header.dataset.path = path;

  const icon = document.createElement('i');
  const folderIcon = document.createElement('i');
  folderIcon.className = 'bi bi-folder2 text-warning';

  const label = document.createElement('span');
  label.className = 'tree-category-label';
  label.textContent = displayName(seg);

  const countBadge = document.createElement('span');
  countBadge.className = 'badge bg-secondary-subtle text-secondary-emphasis ms-1';
  countBadge.style.fontSize = '0.7rem';
  countBadge.textContent = countLeaves(children, path);

  header.appendChild(icon);
  header.appendChild(folderIcon);
  header.appendChild(label);
  header.appendChild(countBadge);

  const childUl = document.createElement('ul');
  childUl.className = 'tree-children';

  const expanded = !!state.expandedNodes[path];
  icon.className = expanded
    ? 'bi bi-chevron-down text-secondary'
    : 'bi bi-chevron-right text-secondary';

  // 자식 lazy 빌드 함수 등록
  childUl._buildFn = () => {
    childUl._buildFn = null;
    const segs = Object.keys(children).sort();
    for (const childSeg of segs) {
      const childPath = `${path}/${childSeg}`;
      const { li: childLi } = buildNode(childSeg, children[childSeg], childPath);
      childUl.appendChild(childLi);
    }
  };

  if (expanded) {
    childUl._buildFn();
    childUl.style.display = '';
  } else {
    childUl.style.display = 'none';
  }

  header.addEventListener('click', () => {
    const nowExpanded = state.expandedNodes[path] = !state.expandedNodes[path];
    icon.className = nowExpanded
      ? 'bi bi-chevron-down text-secondary'
      : 'bi bi-chevron-right text-secondary';
    if (nowExpanded && childUl._buildFn) childUl._buildFn();
    childUl.style.display = nowExpanded ? '' : 'none';
  });

  li.appendChild(header);
  li.appendChild(childUl);
  return li;
}

// ── 일반 노드 (재귀, lazy) ───────────────────────────────────────────────────

function buildNode(seg, children, path) {
  const li = document.createElement('li');
  const hasFiles = !!(state.itemMap && state.itemMap[path]);

  if (isLeaf(children)) {
    li.appendChild(buildLeafRow(seg, path));
    li.dataset.path   = path;
    li.dataset.isLeaf = '1';
    applySearchFilter(li, seg, path);
    return { li };
  }

  // 중간 노드
  const header = document.createElement('div');
  header.className = 'tree-node-toggle';
  header.dataset.path = path;

  const icon = document.createElement('i');

  header.appendChild(icon);

  if (hasFiles) {
    const checkIcon = document.createElement('i');
    checkIcon.className = state.selections[path]
      ? 'bi bi-check-circle-fill text-success'
      : 'bi bi-circle text-secondary';
    checkIcon.dataset.checkIcon = '1';
    checkIcon.style.fontSize  = '0.75rem';
    checkIcon.style.cursor    = 'pointer';
    checkIcon.style.marginRight = '4px';
    checkIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLeafSelection(path, header, checkIcon);
    });
    header.appendChild(checkIcon);
    header.appendChild(makeThumb(path));
    header.dataset.leafPath = path;
    li.dataset.isLeaf = '1';
  }

  const label = document.createElement('span');
  label.textContent = displayName(seg);
  header.appendChild(label);

  const childUl = document.createElement('ul');
  childUl.className = 'tree-children';

  const expanded = !!state.expandedNodes[path];
  icon.className = expanded
    ? 'bi bi-chevron-down text-secondary'
    : 'bi bi-chevron-right text-secondary';

  // 자식 lazy 빌드 함수 등록
  childUl._buildFn = () => {
    childUl._buildFn = null;
    const segs = Object.keys(children).sort();
    for (const childSeg of segs) {
      const childPath = `${path}/${childSeg}`;
      const { li: childLi } = buildNode(childSeg, children[childSeg], childPath);
      childUl.appendChild(childLi);
    }
  };

  if (expanded) {
    childUl._buildFn();
    childUl.style.display = '';
  } else {
    childUl.style.display = 'none';
  }

  header.addEventListener('click', () => {
    const nowExpanded = state.expandedNodes[path] = !state.expandedNodes[path];
    icon.className = nowExpanded
      ? 'bi bi-chevron-down text-secondary'
      : 'bi bi-chevron-right text-secondary';
    if (nowExpanded && childUl._buildFn) childUl._buildFn();
    childUl.style.display = nowExpanded ? '' : 'none';
  });

  li.appendChild(header);
  li.appendChild(childUl);
  li.dataset.path = path;

  return { li };
}

// ── 리프 행 ──────────────────────────────────────────────────────────────────

function buildLeafRow(seg, path) {
  const row = document.createElement('div');
  row.className = 'tree-leaf';
  if (state.selections[path]) row.classList.add('selected');
  row.dataset.leafPath = path;

  const checkIcon = document.createElement('i');
  checkIcon.className = state.selections[path]
    ? 'bi bi-check-circle-fill text-success'
    : 'bi bi-circle text-secondary';
  checkIcon.dataset.checkIcon = '1';
  checkIcon.style.fontSize = '0.75rem';

  const label = document.createElement('span');
  label.textContent = displayName(seg);

  row.appendChild(checkIcon);
  row.appendChild(makeThumb(path));
  row.appendChild(label);

  row.addEventListener('click', () => toggleLeafSelection(path, row, checkIcon));
  return row;
}

// ── 선택 토글 ────────────────────────────────────────────────────────────────

function toggleLeafSelection(path, row, checkIcon) {
  if (state.selections[path]) {
    delete state.selections[path];
    row.classList.remove('selected');
    checkIcon.className = 'bi bi-circle text-secondary';
  } else {
    state.selections[path] = { colors: {} };
    row.classList.add('selected');
    checkIcon.className = 'bi bi-check-circle-fill text-success';
  }
  onSelectionChange();
}

// ── syncLeafUI ───────────────────────────────────────────────────────────────

export function syncLeafUI(path, selected) {
  const row = document.querySelector(`[data-leaf-path="${CSS.escape(path)}"]`);
  if (!row) return;
  if (selected) {
    row.classList.add('selected');
    const icon = row.querySelector('[data-check-icon]');
    if (icon) icon.className = 'bi bi-check-circle-fill text-success';
  } else {
    row.classList.remove('selected');
    const icon = row.querySelector('[data-check-icon]');
    if (icon) icon.className = 'bi bi-circle text-secondary';
  }
}

// ── 검색 ─────────────────────────────────────────────────────────────────────

function applySearchFilter(li, seg, path) {
  const query = (state.searchQuery || '').toLowerCase().trim();
  if (!query) { li.classList.remove('tree-hidden'); return; }
  if (displayName(seg).toLowerCase().includes(query)) {
    li.classList.remove('tree-hidden');
  } else {
    li.classList.add('tree-hidden');
  }
}

export function applySearchToTree() {
  const container = document.getElementById('tree-container');
  if (!container) return;

  const query = (state.searchQuery || '').toLowerCase().trim();

  // 검색어가 있으면 먼저 전체 DOM 강제 빌드
  if (query) ensureFullBuild(container);

  const allLeaves = container.querySelectorAll('[data-is-leaf="1"]');
  allLeaves.forEach(li => {
    const path = li.dataset.path || '';
    const seg  = path.split('/').pop();

    if (!query) {
      li.classList.remove('tree-hidden');
      return;
    }
    const name = displayName(seg).toLowerCase();
    if (name.includes(query) || path.toLowerCase().includes(query)) {
      li.classList.remove('tree-hidden');
      expandParents(li);
    } else {
      li.classList.add('tree-hidden');
    }
  });
}

function expandParents(li) {
  let parent = li.parentElement;
  while (parent && parent.id !== 'tree-container') {
    if (parent.tagName === 'UL' && parent.classList.contains('tree-children')) {
      parent.style.display = '';
      const prevSibling = parent.previousElementSibling;
      if (prevSibling && prevSibling.classList.contains('tree-node-toggle')) {
        const icon = prevSibling.querySelector('i:first-child');
        if (icon) icon.className = 'bi bi-chevron-down text-secondary';
        const pathKey = prevSibling.dataset.path;
        if (pathKey) state.expandedNodes[pathKey] = true;
      }
    }
    parent = parent.parentElement;
  }
}

// ── 전체 접기 ────────────────────────────────────────────────────────────────

export function collapseAll() {
  state.expandedNodes = {};
  const allUls = document.querySelectorAll('.tree-children');
  allUls.forEach(ul => { ul.style.display = 'none'; });
  const allIcons = document.querySelectorAll('.tree-node-toggle i:first-child');
  allIcons.forEach(icon => { icon.className = 'bi bi-chevron-right text-secondary'; });
}
