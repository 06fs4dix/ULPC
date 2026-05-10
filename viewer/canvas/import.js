/**
 * import.js — JSON 임포트 (팝업 → 선택 상태 복원)
 */
import { state, onSelectionChange } from '../state.js';
import { renderTree } from '../ui/tree.js';
import { detectPathPrefix } from '../data/loader.js';

let _loadProject = null;

export function initImport(loadProjectFn) {
  _loadProject = loadProjectFn;
  document.getElementById('btn-import-json')
    ?.addEventListener('click', openImportModal);
  document.getElementById('btn-import-confirm')
    ?.addEventListener('click', applyImport);
}

function openImportModal() {
  const textarea = document.getElementById('import-json-textarea');
  if (textarea) textarea.value = '';
  const errorEl = document.getElementById('import-error');
  if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }

  const modalEl = document.getElementById('import-modal');
  // eslint-disable-next-line no-undef
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

async function applyImport() {
  const textarea = document.getElementById('import-json-textarea');
  const errorEl  = document.getElementById('import-error');

  const showError = (msg) => {
    if (errorEl) { errorEl.textContent = msg; errorEl.style.display = ''; }
  };

  let data;
  try {
    data = JSON.parse(textarea.value.trim());
  } catch (e) {
    showError(`JSON 파싱 오류: ${e.message}`);
    return;
  }

  if (!data.selections || !Array.isArray(data.selections)) {
    showError('"selections" 배열이 없습니다.');
    return;
  }

  // files 첫 세그먼트로 프로젝트 감지
  // KNOWN_CATEGORIES(arms, weapons 등)면 ULPC, 아니면 ZIP 프로젝트명
  let detectedProject = null;
  const allFiles = data.selections.flatMap(sel => sel.files ?? []);
  const prefix = detectPathPrefix(allFiles);
  detectedProject = prefix ? prefix.replace(/\/$/, '') : 'ULPC';

  // 프로젝트 전환 가능 여부 사전 검증 (모달 닫기 전)
  const select = document.getElementById('project-select');
  const needSwitch = detectedProject && detectedProject !== state.selectedProject;
  if (needSwitch) {
    const optionExists = select?.querySelector(`option[value="${CSS.escape(detectedProject)}"]`);
    if (!optionExists) {
      showError(`프로젝트 "${detectedProject}"가 로드되지 않았습니다. 먼저 해당 ZIP 파일을 추가하세요.`);
      return;
    }
  }
  if (!needSwitch && !state.itemMap) {
    showError('프로젝트가 로드되지 않았습니다. 먼저 프로젝트를 선택하세요.');
    return;
  }

  // 모달 닫기
  const modalEl = document.getElementById('import-modal');
  // eslint-disable-next-line no-undef
  bootstrap.Modal.getInstance(modalEl)?.hide();

  // 다른 프로젝트면 전환
  if (needSwitch && _loadProject) {
    if (select) select.value = detectedProject;
    await _loadProject(detectedProject);
  }

  // 선택 상태 적용
  // state.itemMap 키가 프로젝트명 포함 여부에 따라 export path의 prefix 제거 결정
  // ULPC: itemMap 키 = 'arms/...' (prefix 없음) → export path 'ULPC/arms/...'에서 'ULPC/' 제거
  // ZIP:  itemMap 키 = 'Monster/...' (prefix 있음) → 그대로 사용
  const projStrip = detectedProject ? detectedProject + '/' : '';
  const firstItemKey = Object.keys(state.itemMap ?? {})[0] ?? '';
  const itemMapHasPrefix = projStrip && firstItemKey.startsWith(projStrip);
  const newSelections = {};
  for (const sel of data.selections) {
    if (!sel.path) continue;
    const stateKey = (!itemMapHasPrefix && projStrip && sel.path.startsWith(projStrip))
      ? sel.path.slice(projStrip.length) : sel.path;
    // sel.recolors: { "metal.ulpc": { color: "steel", base: [...], recolor: [...] } }
    // → colors: { "metal.ulpc": "steel" }
    const colors = {};
    if (sel.recolors && typeof sel.recolors === 'object') {
      for (const [matKey, info] of Object.entries(sel.recolors)) {
        if (info?.color) colors[matKey] = info.color;
      }
    }
    newSelections[stateKey] = { colors: Object.keys(colors).length > 0 ? colors : null };
  }
  state.selections = newSelections;

  // 팔레트 병합 (임포트 JSON에 포함된 팔레트 추가)
  if (data.palettes && typeof data.palettes === 'object' && state.palettes) {
    for (const [material, versions] of Object.entries(data.palettes)) {
      if (!state.palettes[material]) state.palettes[material] = {};
      for (const [version, colors] of Object.entries(versions)) {
        if (!state.palettes[material][version]) state.palettes[material][version] = {};
        for (const [color, hexArr] of Object.entries(colors)) {
          if (!state.palettes[material][version][color]) {
            state.palettes[material][version][color] = hexArr;
          }
        }
      }
    }
  }

  // 트리 + 패널 + 캔버스 갱신
  renderTree();
  onSelectionChange();
}
