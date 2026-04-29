/**
 * import.js — JSON 임포트 (팝업 → 선택 상태 복원)
 */
import { state, onSelectionChange } from '../state.js';
import { renderTree } from '../ui/tree.js';

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

  // files 배열 첫 번째 항목에서 프로젝트 prefix 감지
  let detectedProject = null;
  for (const sel of data.selections) {
    if (Array.isArray(sel.files) && sel.files.length > 0) {
      detectedProject = sel.files[0].split('/')[0];
      break;
    }
  }

  // 모달 닫기
  const modalEl = document.getElementById('import-modal');
  // eslint-disable-next-line no-undef
  bootstrap.Modal.getInstance(modalEl)?.hide();

  // 다른 프로젝트면 먼저 전환
  if (detectedProject && detectedProject !== state.selectedProject && _loadProject) {
    const select = document.getElementById('project-select');
    if (select) select.value = detectedProject;
    await _loadProject(detectedProject);
  }

  // 선택 상태 적용
  const newSelections = {};
  for (const sel of data.selections) {
    if (!sel.path) continue;
    newSelections[sel.path] = { colors: sel.colors ?? null };
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
