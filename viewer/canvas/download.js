/**
 * download.js — JSON / 스프라이트시트 PNG 다운로드
 */
import { renderFullSheet } from './renderer.js';
import { parseFilename } from '../data/loader.js';
import { state } from '../state.js';
import { ANIM_NAMES } from './animation.js';

export function initDownload() {
  document.getElementById('btn-download-json')
    ?.addEventListener('click', openExportModal);
  document.getElementById('btn-download-sheet')
    ?.addEventListener('click', downloadSheet);
  document.getElementById('btn-export-json')
    ?.addEventListener('click', downloadJSON);
  document.getElementById('btn-export-base64')
    ?.addEventListener('click', downloadBase64);
  document.getElementById('btn-export-anim-all')
    ?.addEventListener('click', () => {
      document.querySelectorAll('#export-anim-list input[type=checkbox]')
        .forEach(cb => (cb.checked = true));
    });
  document.getElementById('btn-export-anim-none')
    ?.addEventListener('click', () => {
      document.querySelectorAll('#export-anim-list input[type=checkbox]')
        .forEach(cb => (cb.checked = false));
    });
}

// ── Export 모달 ──────────────────────────────────────────────────────────

/** 현재 선택 아이템에 실제로 존재하는 애니메이션 목록 반환 */
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
  return [
    ...ANIM_NAMES.filter(n => available.has(n)),
    ...[...available].filter(n => !ANIM_NAMES.includes(n)).sort(),
  ];
}

/** Export 모달 열기 — 애니메이션 체크박스 목록 채우고 표시 */
function openExportModal() {
  const listEl = document.getElementById('export-anim-list');
  if (listEl) {
    listEl.innerHTML = '';
    for (const name of getAvailableAnimations()) {
      const id  = `export-anim-${name}`;
      const div = document.createElement('div');
      div.className = 'form-check';
      div.innerHTML =
        `<input class="form-check-input" type="checkbox" value="${name}" id="${id}" checked>` +
        `<label class="form-check-label small" for="${id}">${name.replace(/_/g, ' ')}</label>`;
      listEl.appendChild(div);
    }
  }
  bootstrap.Modal.getOrCreateInstance(
    document.getElementById('export-modal')
  ).show();
}

/** 모달에서 체크된 애니메이션 Set 반환 */
function getSelectedAnimations() {
  return new Set(
    [...document.querySelectorAll('#export-anim-list input[type=checkbox]:checked')]
      .map(cb => cb.value)
  );
}

// ── JSON 내보내기 ──────────────────────────────────────────────────────────

/** JSON 버튼 — 모달 닫고 JSON 파일 다운로드 */
async function downloadJSON() {
  bootstrap.Modal.getOrCreateInstance(
    document.getElementById('export-modal')
  ).hide();
  const selectedAnims = getSelectedAnimations();
  const data = buildExportData(selectedAnims);
  if (document.getElementById('export-base64-check')?.checked)
    await injectBase64s(data);
  const json = JSON.stringify(data, null, 2);
  triggerDownload(new Blob([json], { type: 'application/json' }), 'ulpc_selection.json');
}

/** base64 txt 버튼 — JSON을 base64로 인코딩해서 .txt 파일로 다운로드 */
async function downloadBase64() {
  bootstrap.Modal.getOrCreateInstance(
    document.getElementById('export-modal')
  ).hide();
  const selectedAnims = getSelectedAnimations();
  const data = buildExportData(selectedAnims);
  if (document.getElementById('export-base64-check')?.checked)
    await injectBase64s(data);
  const json = JSON.stringify(data, null, 2);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  triggerDownload(new Blob([b64], { type: 'text/plain' }), 'ulpc_selection.txt');
}

/**
 * 내보낼 JSON 데이터 빌드
 *
 * {
 *   selections: [
 *     {
 *       path: "arms/p[armour]/p[plate]/p[female]",
 *       colors: { "metal.ulpc": "steel", "cloth.ulpc": "blue" },
 *       files: [ "arms/.../a[walk]_512/z60/metal.ulpc.steel_64_9_0213.png", ... ]
 *     }, ...
 *   ],
 *   palettes: {
 *     "metal": { "ulpc": { "steel": ["#hex", ...] } },
 *     ...
 *   }
 * }
 */
export function buildExportData(selectedAnims = null) {
  const prefixes = Object.keys(state.selections);

  const selections = prefixes.map(prefix => {
    const sel = state.selections[prefix];
    const selectedColors = sel?.colors ?? {};

    const allFiles = state.itemMap?.[prefix] || [];

    // (animSeg × zSeg × matKey) 슬롯당 파일 하나만 선택
    // 같은 슬롯에 여러 파일이 있으면 선택된 컬러 우선, 같은 우선순위면 프레임 수가 많은 파일
    const slotMap = new Map(); // slotKey → { file, parsed, matKey }

    for (const f of allFiles) {
      const segs = f.split('/');
      const aIdx = segs.findIndex(s => /^a\[/.test(s));
      if (aIdx < 0) continue;
      const animSeg = segs[aIdx];
      // 선택된 애니메이션 필터
      if (selectedAnims) {
        const m = animSeg.match(/^a\[(.+)\]$/);
        if (!m || !selectedAnims.has(m[1])) continue;
      }
      const zSeg    = segs[aIdx + 1];
      const fname   = segs[aIdx + 2];
      if (!fname) continue;
      const parsed = parseFilename(fname);
      if (!parsed) continue;

      const matKey  = parsed.material ? `${parsed.material}.${parsed.version}` : null;
      const slotKey = `${animSeg}|${zSeg}|${matKey ?? 'default'}`;
      const existing = slotMap.get(slotKey);

      if (!existing) {
        slotMap.set(slotKey, { file: f, parsed, matKey });
      } else {
        // 선택된 컬러와 일치하는 파일 우선, 그 다음 프레임 수 많은 파일
        const selectedColor = matKey ? (selectedColors[matKey] ?? null) : null;
        const newIsSelected = selectedColor && parsed.color === selectedColor;
        const oldIsSelected = selectedColor && existing.parsed.color === selectedColor;
        if (newIsSelected && !oldIsSelected) {
          slotMap.set(slotKey, { file: f, parsed, matKey });
        } else if (newIsSelected === oldIsSelected && parsed.frameCount > existing.parsed.frameCount) {
          slotMap.set(slotKey, { file: f, parsed, matKey });
        }
      }
    }

    // 선택된 파일 목록 + matKey별 base 색상 수집
    const files = [];
    const matBaseColor = {};
    for (const { file, parsed, matKey } of slotMap.values()) {
      files.push(file);
      if (matKey && !matBaseColor[matKey]) matBaseColor[matKey] = parsed.color;
    }

    // recolors: matKey → { color, base[], recolor[] }
    const recolors = {};
    for (const [matKey, colorName] of Object.entries(selectedColors)) {
      const dot      = matKey.indexOf('.');
      const material = matKey.slice(0, dot);
      const version  = matKey.slice(dot + 1);
      const baseColor = matBaseColor[matKey];
      recolors[matKey] = {
        color:   colorName,
        base:    baseColor ? (state.palettes?.[material]?.[version]?.[baseColor] ?? []) : [],
        recolor: state.palettes?.[material]?.[version]?.[colorName] ?? [],
      };
    }

    // path/files에 프로젝트명이 없으면 prepend (ULPC는 'arms/...' 형태라 없음)
    const proj = state.selectedProject;
    const projPrefix = proj ? proj + '/' : '';
    const exportPath  = (projPrefix && !prefix.startsWith(projPrefix)) ? projPrefix + prefix : prefix;
    const exportFiles = files.map(f =>
      (projPrefix && !f.startsWith(projPrefix)) ? projPrefix + f : f
    );

    return { path: exportPath, recolors, files: exportFiles };
  });

  const result = { version: 3, selections };
  const resBase = document.getElementById('export-res-base')?.value.trim();
  if (resBase) result.resBase = resBase;
  return result;
}


// ── base64 이미지 수집 ────────────────────────────────────────────────────

/**
 * 각 selection의 files[]에 대응하는 base64s[] 배열을 추가한다.
 * CParserULPC가 sel.base64s[fi]를 files[fi]와 병렬로 읽는 구조에 맞춘다.
 */
async function injectBase64s(exportData) {
  const proj       = state.selectedProject;
  const projPrefix = proj ? proj + '/' : '';
  const imageBase  = state.imageBase ?? `../spritesheets/${proj}/`;

  await Promise.all(exportData.selections.map(async (sel) => {
    const base64s = await Promise.all((sel.files ?? []).map(async (exportFile) => {
      const rawPath = exportFile.startsWith(projPrefix)
        ? exportFile.slice(projPrefix.length)
        : exportFile;
      const encodedPath = rawPath.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
      const url = state.zipBlobs.size > 0
        ? (state.zipBlobs.get(rawPath) ?? (imageBase + encodedPath))
        : (imageBase + encodedPath);
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch { return null; }
    }));
    sel.base64s = base64s;
  }));
}

// ── 스프라이트시트 PNG 다운로드 ────────────────────────────────────────────

/** 전체 스프라이트시트 다운로드 */
async function downloadSheet() {
  const btnSheet = document.getElementById('btn-download-sheet');
  if (btnSheet) {
    btnSheet.disabled = true;
    btnSheet.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Rendering…';
  }
  try {
    const offscreen = await renderFullSheet();
    if (!offscreen) return;
    const blob = await new Promise(res => offscreen.toBlob(res, 'image/png'));
    triggerDownload(blob, 'ulpc_spritesheet.png');
  } finally {
    if (btnSheet) {
      btnSheet.disabled = false;
      btnSheet.innerHTML = '<i class="bi bi-grid-3x3 me-1"></i> Download Full Sheet';
    }
  }
}

// ── 공통 ──────────────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
