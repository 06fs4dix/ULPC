/**
 * tree.js — Bootstrap 기반 재귀 폴더 트리 렌더
 */
import { displayName, isLeaf, parseFilename } from '../data/loader.js';
import { state, onSelectionChange } from '../state.js';

// ── 썸네일 ──────────────────────────────────────────────────────────────────

const THUMB_SIZE = 20; // CSS + canvas px
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
    const f = files.find(f => f.includes(`/a[${anim}]_`));
    if (f) return f;
  }
  return files[0] || null;
}

async function _drawThumb(canvas, path) {
  const files = state.itemMap?.[path];
  if (!files || files.length === 0) return;

  const file = _pickThumbFile(files);
  if (!file) return;

  const segs  = file.split('/');
  const aIdx  = segs.findIndex(s => /^a\[/.test(s));
  if (aIdx < 0) return;

  const animName = (segs[aIdx].match(/^a\[(.+)\]$/) || [])[1] || '';
  const fname    = segs[aIdx + 2];
  if (!fname) return;

  // parseFilename으로 frameSize와 dirs 추출 (구/신 형식 모두 대응)
  const parsed = parseFilename(fname);
  if (!parsed) return;
  const { frameSize, dirs } = parsed;

  // dirs === '1' 이면 방향 없음, 나머지는 S(앞면) 행 사용
  // ULPC 코드 S=1: dirs에서 '1'의 위치가 South 행
  const dirless = dirs === '1' || animName === 'hurt' || animName === 'climb';
  const srcX = 0;
  const southRow = dirless ? 0 : (dirs ? Math.max(0, dirs.indexOf('1')) : 2);
  const srcY = southRow * frameSize;

  const imageBase  = state.imageBase  || '../spritesheets/';
  const url = imageBase + _encodeFilePath(file);
  try {
    const img = await _loadImage(url);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, srcY, frameSize, frameSize, 0, 0, THUMB_SIZE, THUMB_SIZE);
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

/** 썸네일 canvas 엘리먼트 생성 */
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

/**
 * 트리 전체를 #tree-container 에 렌더링
 */
export function renderTree() {
  const container = document.getElementById('tree-container');
  if (!container || !state.tree) return;
  container.innerHTML = '';

  const ul = document.createElement('ul');
  ul.className = 'tree-root';

  // 카테고리(최상위 키) 순 정렬
  const categories = Object.keys(state.tree).sort();
  for (const cat of categories) {
    const li = buildCategoryNode(cat, state.tree[cat], cat);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

/** 카테고리 루트 노드 (특별 표시) */
function buildCategoryNode(seg, children, path) {
  const li = document.createElement('li');

  // 헤더 행
  const header = document.createElement('div');
  header.className = 'tree-node-toggle d-flex align-items-center gap-1 py-1';
  header.dataset.path = path;

  const icon = document.createElement('i');
  icon.className = state.expandedNodes[path]
    ? 'bi bi-chevron-down text-secondary'
    : 'bi bi-chevron-right text-secondary';

  const folderIcon = document.createElement('i');
  folderIcon.className = 'bi bi-folder2 text-warning';

  const label = document.createElement('span');
  label.className = 'tree-category-label';
  label.textContent = displayName(seg);

  // 아이템 수 뱃지
  const countBadge = document.createElement('span');
  countBadge.className = 'badge bg-secondary-subtle text-secondary-emphasis ms-1';
  countBadge.style.fontSize = '0.7rem';

  header.appendChild(icon);
  header.appendChild(folderIcon);
  header.appendChild(label);
  header.appendChild(countBadge);

  // 자식 컨테이너
  const childUl = document.createElement('ul');
  childUl.className = 'tree-children';
  if (!state.expandedNodes[path]) childUl.style.display = 'none';

  // 자식 노드 재귀 빌드
  let leafCount = 0;
  const childSegs = Object.keys(children).sort();
  for (const childSeg of childSegs) {
    const childPath = `${path}/${childSeg}`;
    const childNode = children[childSeg];
    const { li: childLi, leafCount: lc } = buildNode(childSeg, childNode, childPath);
    leafCount += lc;
    childUl.appendChild(childLi);
  }
  countBadge.textContent = leafCount;

  // 토글 이벤트
  header.addEventListener('click', () => {
    const expanded = state.expandedNodes[path] = !state.expandedNodes[path];
    icon.className = expanded
      ? 'bi bi-chevron-down text-secondary'
      : 'bi bi-chevron-right text-secondary';
    childUl.style.display = expanded ? '' : 'none';
  });

  li.appendChild(header);
  li.appendChild(childUl);
  return li;
}

/**
 * 일반 노드 (재귀)
 * 반환: { li, leafCount }
 */
function buildNode(seg, children, path) {
  const li = document.createElement('li');
  let leafCount = 0;

  // itemMap에 파일이 있으면 선택 가능 (리프이든 중간 노드이든)
  const hasFiles = !!(state.itemMap && state.itemMap[path]);

  if (isLeaf(children)) {
    // 순수 리프 노드 = 선택 가능한 아이템
    leafCount = 1;
    const row = buildLeafRow(seg, path);
    li.appendChild(row);
    li.dataset.path = path;
    li.dataset.isLeaf = '1';

    // 검색 필터 적용
    applySearchFilter(li, seg);
  } else {
    // 중간 노드 (폴더)
    const header = document.createElement('div');
    header.className = 'tree-node-toggle';
    header.dataset.path = path;

    const icon = document.createElement('i');
    icon.className = state.expandedNodes[path]
      ? 'bi bi-chevron-down text-secondary'
      : 'bi bi-chevron-right text-secondary';

    header.appendChild(icon);

    // 이 노드 자체도 itemMap에 파일이 있으면 선택 버튼 + 썸네일 추가
    if (hasFiles) {
      leafCount = 1;
      const checkIcon = document.createElement('i');
      checkIcon.className = state.selections[path]
        ? 'bi bi-check-circle-fill text-success'
        : 'bi bi-circle text-secondary';
      checkIcon.dataset.checkIcon = '1';
      checkIcon.style.fontSize = '0.75rem';
      checkIcon.style.cursor = 'pointer';
      checkIcon.style.marginRight = '4px';
      checkIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = header; // 헤더를 row 대역으로 사용
        toggleLeafSelection(path, row, checkIcon);
      });
      header.appendChild(checkIcon);
      header.appendChild(makeThumb(path));

      // data-leaf-path 도 header에 부여 (syncLeafUI 대응)
      header.dataset.leafPath = path;
      li.dataset.isLeaf = '1';
    }

    const label = document.createElement('span');
    label.textContent = displayName(seg);
    header.appendChild(label);

    const childUl = document.createElement('ul');
    childUl.className = 'tree-children';
    if (!state.expandedNodes[path]) childUl.style.display = 'none';

    const childSegs = Object.keys(children).sort();
    for (const childSeg of childSegs) {
      const childPath = `${path}/${childSeg}`;
      const childNode = children[childSeg];
      const { li: childLi, leafCount: lc } = buildNode(childSeg, childNode, childPath);
      leafCount += lc;
      childUl.appendChild(childLi);
    }

    header.addEventListener('click', () => {
      const expanded = state.expandedNodes[path] = !state.expandedNodes[path];
      icon.className = expanded
        ? 'bi bi-chevron-down text-secondary'
        : 'bi bi-chevron-right text-secondary';
      childUl.style.display = expanded ? '' : 'none';
    });

    li.appendChild(header);
    li.appendChild(childUl);
    li.dataset.path = path;
  }

  return { li, leafCount };
}

/** 리프 행 엘리먼트 생성 */
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

/** 리프 선택/해제 토글 */
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

/** 선택된 리프의 check 아이콘 동기화 */
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


/** 검색 필터 적용 */
function applySearchFilter(li, seg) {
  const query = (state.searchQuery || '').toLowerCase().trim();
  if (!query) {
    li.classList.remove('tree-hidden');
    return;
  }
  if (displayName(seg).toLowerCase().includes(query)) {
    li.classList.remove('tree-hidden');
  } else {
    li.classList.add('tree-hidden');
  }
}

/**
 * 검색 필터 재적용 (트리 DOM 순회)
 */
export function applySearchToTree() {
  const query = (state.searchQuery || '').toLowerCase().trim();
  const allLeaves = document.querySelectorAll('[data-is-leaf="1"]');
  allLeaves.forEach(li => {
    const path = li.dataset.path || '';
    const seg = path.split('/').pop();

    if (!query) {
      li.classList.remove('tree-hidden');
      return;
    }
    const name = displayName(seg).toLowerCase();
    if (name.includes(query) || path.toLowerCase().includes(query)) {
      li.classList.remove('tree-hidden');
      // 부모 자동 펼침
      expandParents(li);
    } else {
      li.classList.add('tree-hidden');
    }
  });
}


/** 검색 매칭 아이템의 조상 accordion 노드 자동 펼침 */
function expandParents(li) {
  let parent = li.parentElement;
  while (parent && parent.id !== 'tree-container') {
    if (parent.tagName === 'UL' && parent.classList.contains('tree-children')) {
      parent.style.display = '';
      // 아이콘 업데이트
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

/** 모든 노드 접기 */
export function collapseAll() {
  state.expandedNodes = {};
  const allUls = document.querySelectorAll('.tree-children');
  allUls.forEach(ul => { ul.style.display = 'none'; });
  const allIcons = document.querySelectorAll('.tree-node-toggle i:first-child');
  allIcons.forEach(icon => { icon.className = 'bi bi-chevron-right text-secondary'; });
}
