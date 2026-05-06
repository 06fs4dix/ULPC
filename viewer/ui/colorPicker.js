/**
 * colorPicker.js — 선택된 아이템 패널 + 팔레트 스와치 UI
 */
import { getAvailableColors } from '../data/loader.js';
import { state, onSelectionChange } from '../state.js';

/**
 * "Selected Items" 패널 전체 갱신
 */
export function renderSelectedPanel() {
  const container = document.getElementById('selected-items-list');
  const countBadge = document.getElementById('selected-count');
  if (!container) return;

  const prefixes = Object.keys(state.selections);
  if (countBadge) countBadge.textContent = prefixes.length;

  if (prefixes.length === 0) {
    container.innerHTML = '<p class="text-secondary small mb-0 p-2">No items selected.</p>';
    return;
  }

  container.innerHTML = '';

  for (const prefix of prefixes) {
    const row = buildItemRow(prefix);
    container.appendChild(row);
  }
}

function buildItemRow(prefix) {
  const wrapper = document.createElement('div');
  wrapper.className = 'selected-item-row';

  // 1행: 이름 + 제거 버튼
  const headerRow = document.createElement('div');
  headerRow.className = 'd-flex align-items-center gap-1';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'selected-item-name';
  nameSpan.textContent = formatPrefix(prefix);
  nameSpan.title = prefix;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-sm btn-outline-danger ms-auto flex-shrink-0';
  removeBtn.style.padding = '1px 6px';
  removeBtn.innerHTML = '<i class="bi bi-x"></i>';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', () => {
    delete state.selections[prefix];
    const row = document.querySelector(`[data-leaf-path="${CSS.escape(prefix)}"]`);
    if (row) {
      row.classList.remove('selected');
      const icon = row.querySelector('[data-check-icon]');
      if (icon) icon.className = 'bi bi-circle text-secondary';
    }
    renderSelectedPanel();
    onSelectionChange();
  });

  headerRow.appendChild(nameSpan);
  headerRow.appendChild(removeBtn);
  wrapper.appendChild(headerRow);

  // 머티리얼 그룹별 스와치 렌더링
  const colorGroups = getAvailableColors(prefix, state.itemMap, state.palettes);
  const sel = state.selections[prefix];

  // 하위 호환: 구형 { color } 구조를 { colors } 로 마이그레이션
  if (!sel.colors) sel.colors = {};

  // 모든 팔레트 그룹이 공유하는 단일 선택 키 (첫 번째 non-null 그룹 기준)
  const firstGroup = colorGroups.find(g => g.material !== null);
  if (!firstGroup) return wrapper;
  const primaryKey = `${firstGroup.material}.${firstGroup.version}`;

  // 초기 선택값 설정 (한 번만) — 기본은 원본 그대로(__original__)
  if (!sel.colors[primaryKey]) {
    sel.colors[primaryKey] = '__original__';
  }

  // 구형 키들(다른 matKey)이 남아 있으면 제거하고 primaryKey로 통합
  for (const key of Object.keys(sel.colors)) {
    if (key !== primaryKey) delete sel.colors[key];
  }

  const nonNullGroups = colorGroups.filter(g => g.material !== null);

  for (const group of nonNullGroups) {
    const makeFullId = (colorName) => `${group.material}.${group.version}.${colorName}`;

    // 그룹 레이블 (머티리얼이 2개 이상일 때만 표시)
    if (nonNullGroups.length > 1) {
      const label = document.createElement('div');
      label.className = 'swatch-group-label';
      label.textContent = group.material === 'all'
        ? `all (${group.version})`
        : `${group.material} (${group.version})`;
      wrapper.appendChild(label);
    }

    const swatchWrap = document.createElement('div');
    swatchWrap.className = 'd-flex flex-wrap gap-1';

    // X 버튼 — 리컬러 없이 원본 그대로 표시
    {
      const btn = document.createElement('button');
      btn.className = 'swatch-btn swatch-original';
      btn.title = '원본 (리컬러 없음)';
      btn.innerHTML = '<i class="bi bi-x-lg"></i>';
      if (sel.colors[primaryKey] === '__original__') btn.classList.add('active');
      btn.addEventListener('click', () => {
        wrapper.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sel.colors[primaryKey] = '__original__';
        onSelectionChange();
      });
      swatchWrap.appendChild(btn);
    }

    for (const colorName of group.colors) {
      let hexArr = state.palettes?.[group.material]?.[group.version]?.[colorName];
      if (!hexArr && !group.material) {
        hexArr = findColorHexAnywhere(state.palettes, colorName);
      }
      const hex = hexArr ? hexArr[Math.floor(hexArr.length / 2)] : null;
      const fullId = makeFullId(colorName);
      const btn = document.createElement('button');
      btn.className = 'swatch-btn';
      btn.title = colorName;
      btn.style.background = hex || '#ccc';
      if (fullId === sel.colors[primaryKey]) btn.classList.add('active');
      btn.addEventListener('click', () => {
        wrapper.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sel.colors[primaryKey] = fullId;
        onSelectionChange();
      });
      swatchWrap.appendChild(btn);
    }

    wrapper.appendChild(swatchWrap);
  }

  return wrapper;
}

/**
 * 팔레트 전체를 검색해 color 이름과 일치하는 첫 번째 hex 배열 반환
 * 우선순위: 'all' material → 나머지 material
 * material=null 파일의 스와치 색상 표시에 사용
 */
function findColorHexAnywhere(palettes, colorName) {
  if (!palettes) return null;
  const matKeys = ['all', ...Object.keys(palettes).filter(k => k !== 'all')];
  for (const mat of matKeys) {
    const vers = palettes[mat];
    if (!vers) continue;
    for (const verColors of Object.values(vers)) {
      if (verColors[colorName]) return verColors[colorName];
    }
  }
  return null;
}

/** prefix → 읽기 좋은 표시명 변환 */
function formatPrefix(prefix) {
  return prefix.split('/').map(seg => {
    if (seg.startsWith('p[') && seg.endsWith(']')) return seg.slice(2, -1);
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }).join(' / ');
}

/**
 * 팔레트에서 스와치 대표 색상 hex 반환
 * palettes[material][version][color] = hex[]
 */
export function getSwatchHex(colorInfo, palettes) {
  if (!palettes) return null;
  const { material, version, color } = colorInfo;
  try {
    const hexArr = palettes[material]?.[version]?.[color];
    if (!hexArr || hexArr.length === 0) return null;
    return hexArr[Math.floor(hexArr.length / 2)];
  } catch {
    return null;
  }
}
