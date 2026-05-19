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
  // eslint-disable-next-line no-undef
  bootstrap.Modal.getOrCreateInstance(document.getElementById('import-modal')).show();
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

  // 프로젝트 전환 가능 여부 사전 검증 (모달 닫기 전)
  const allFiles = data.selections.flatMap(sel => sel.files ?? []);
  const allPaths = allFiles.length > 0 ? allFiles : data.selections.map(sel => sel.path).filter(Boolean);
  const prefix = detectPathPrefix(allPaths);
  const detectedProject = prefix ? prefix.replace(/\/$/, '') : 'ULPC';
  const select = document.getElementById('project-select');
  const needSwitch = detectedProject && detectedProject !== state.selectedProject;
  if (needSwitch) {
    if (!select?.querySelector(`option[value="${CSS.escape(detectedProject)}"]`)) {
      showError(`프로젝트 "${detectedProject}"가 로드되지 않았습니다. 먼저 해당 ZIP 파일을 추가하세요.`);
      return;
    }
  }
  if (!needSwitch && !state.itemMap) {
    showError('프로젝트가 로드되지 않았습니다. 먼저 프로젝트를 선택하세요.');
    return;
  }

  // eslint-disable-next-line no-undef
  bootstrap.Modal.getInstance(document.getElementById('import-modal'))?.hide();
  await applyImportData(data, _loadProject);
}

/** data 객체를 직접 받아 선택 상태를 복원한다 (presets 등 외부에서 재사용) */
export async function applyImportData(data, loadProjectFn = null) {
  if (!data?.selections || !Array.isArray(data.selections)) return;

  const allFiles = data.selections.flatMap(sel => sel.files ?? []);
  const allPaths = allFiles.length > 0 ? allFiles : data.selections.map(sel => sel.path).filter(Boolean);
  const prefix = detectPathPrefix(allPaths);
  const detectedProject = prefix ? prefix.replace(/\/$/, '') : 'ULPC';

  const select = document.getElementById('project-select');
  const needSwitch = detectedProject && (detectedProject !== state.selectedProject || !state.itemMap);
  if (needSwitch && loadProjectFn) {
    if (select) select.value = detectedProject;
    await loadProjectFn(detectedProject);
  }

  const projStrip = detectedProject ? detectedProject + '/' : '';
  const firstItemKey = Object.keys(state.itemMap ?? {})[0] ?? '';
  const itemMapHasPrefix = projStrip && firstItemKey.startsWith(projStrip);
  const newSelections = {};
  for (const sel of data.selections) {
    if (!sel.path) continue;
    const stateKey = (!itemMapHasPrefix && projStrip && sel.path.startsWith(projStrip))
      ? sel.path.slice(projStrip.length) : sel.path;
    const colors = {};
    if (sel.recolors && typeof sel.recolors === 'object') {
      for (const [matKey, info] of Object.entries(sel.recolors)) {
        if (info?.color) colors[matKey] = info.color;
      }
    }
    newSelections[stateKey] = { colors: Object.keys(colors).length > 0 ? colors : null };
  }
  state.selections = newSelections;

  if (data.palettes && typeof data.palettes === 'object' && state.palettes) {
    for (const [material, versions] of Object.entries(data.palettes)) {
      if (!state.palettes[material]) state.palettes[material] = {};
      for (const [version, colors] of Object.entries(versions)) {
        if (!state.palettes[material][version]) state.palettes[material][version] = {};
        for (const [color, hexArr] of Object.entries(colors)) {
          if (!state.palettes[material][version][color])
            state.palettes[material][version][color] = hexArr;
        }
      }
    }
  }

  renderTree();
  onSelectionChange();
}
