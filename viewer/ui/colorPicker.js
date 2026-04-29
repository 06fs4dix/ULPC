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

  for (const group of colorGroups) {
    const matKey = group.material ? `${group.material}.${group.version}` : 'default';

    // 초기 선택값: 실제 파일 색상(fileColors[0]) 우선, 없으면 팔레트 첫 번째
    if (!sel.colors[matKey]) {
      sel.colors[matKey] = group.fileColors?.[0] ?? group.colors[0] ?? null;
    }

    // 그룹 레이블 (머티리얼이 2개 이상일 때만 표시)
    if (group.material && colorGroups.length > 1) {
      const label = document.createElement('div');
      label.className = 'swatch-group-label';
      label.textContent = group.material;
      wrapper.appendChild(label);
    }

    const swatchWrap = document.createElement('div');
    swatchWrap.className = 'd-flex flex-wrap gap-1';

    for (const colorName of group.colors) {
      const hexArr = state.palettes?.[group.material]?.[group.version]?.[colorName];
      const hex = hexArr ? hexArr[Math.floor(hexArr.length / 2)] : null;
      const btn = document.createElement('button');
      btn.className = 'swatch-btn';
      btn.title = colorName;
      btn.style.background = hex || '#ccc';
      if (colorName === sel.colors[matKey]) btn.classList.add('active');
      btn.addEventListener('click', () => {
        sel.colors[matKey] = colorName;
        swatchWrap.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onSelectionChange();
      });
      swatchWrap.appendChild(btn);
    }

    wrapper.appendChild(swatchWrap);
  }

  return wrapper;
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
