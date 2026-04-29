/**
 * download.js — JSON / 스프라이트시트 PNG 다운로드
 */
import { renderFullSheet } from './renderer.js';
import { parseFilename } from '../data/loader.js';
import { state } from '../state.js';

export function initDownload() {
  document.getElementById('btn-download-json')
    ?.addEventListener('click', downloadJSON);
  document.getElementById('btn-download-sheet')
    ?.addEventListener('click', downloadSheet);
}

// ── JSON 다운로드 ──────────────────────────────────────────────────────────

/** 선택된 아이템 + 팔레트 정보를 JSON으로 내보내기 */
function downloadJSON() {
  const data = buildExportData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  triggerDownload(blob, 'ulpc_selection.json');
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
function buildExportData() {
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

    return { path: prefix, recolors, files };
  });

  const result = { version: 3, selections };
  const resBase = document.getElementById('input-res-base')?.value.trim();
  if (resBase) result.resBase = resBase;
  return result;
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
