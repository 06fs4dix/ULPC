/**
 * renderer.js — 캐릭터 합성 렌더러
 *
 * buildCharacterSheet(): 선택된 아이템 전체를 사전 베이크
 *   - 존재하는 애니메이션을 순차적으로 탐색 → 각 애니당 최대 frameSize 확정
 *   - 동적으로 y좌표를 쌓아가며 애니메이션 레이아웃 기록
 *   - a[all] 아이템: yOffset/64 = 행번호로 해당 위치를 읽어 모든 애니에 기여
 *
 * renderCharacter(): 동기, 베이크된 시트에서 프레임 복사만 수행
 */
import { getItemInfo, parseFilename } from '../data/loader.js';
import { ANIM_META, ANIM_NAMES } from '../canvas/animation.js';
import { state } from '../state.js';

// UI selectedDirection → ULPC 방향 코드 (N=0, S=1, W=2, E=3)
// state.js: 0=up, 1=left, 2=down, 3=right
const UI_TO_ULPC_DIR = [0, 2, 1, 3];

/**
 * dirs 인코딩을 사용해 selectedDirection → 행 인덱스 변환
 * dirs 문자열의 각 자리 = 해당 행에 저장된 방향(ULPC 코드)
 * 예) '1203': row0=S(1), row1=W(2), row2=N(0), row3=E(3)
 */
function getDirectionRow(selectedDir, dirs, dirCount) {
  if (!dirs) return Math.min(selectedDir, dirCount - 1);
  const code = UI_TO_ULPC_DIR[selectedDir] ?? selectedDir;
  const row  = dirs.indexOf(String(code));
  return row >= 0 ? Math.min(row, dirCount - 1) : Math.min(selectedDir, dirCount - 1);
}

// 이미지 캐시 (url → HTMLImageElement)
const imageCache = new Map();

// 팔레트 스왑 캐시 (url::fromColor::toColor → HTMLCanvasElement | null)
const swapCache = new Map();

export function clearImageCache() {
  imageCache.clear();
}

// buildCharacterSheet 동시 실행 방지용 버전 카운터
// 새 호출이 시작되면 이전 호출은 결과를 버림 (race condition 방지)
let _buildVersion = 0;

export function clearSwapCache() {
  swapCache.clear();
}

/** URL 경로 인코딩: [, ] → %5B, %5D */
function encodeFilePath(filePath) {
  return filePath.split('/').map(seg =>
    seg.replace(/\[/g, '%5B').replace(/\]/g, '%5D')
  ).join('/');
}

/** 이미지 로드 (캐시)
 *  ZIP 프로젝트: state.zipBlobs 에서 Blob URL 우선 조회
 */
function loadImage(url) {
  // ZIP 프로젝트: imageBase 접두어 제거 후 zipBlobs 조회
  if (state.zipBlobs.size > 0) {
    const decoded  = decodeURIComponent(url);
    const base     = state.imageBase || '';
    const filePath = base ? (decoded.startsWith(base) ? decoded.slice(base.length) : decoded) : decoded;
    const blobUrl  = state.zipBlobs.get(filePath);
    if (blobUrl) url = blobUrl;
  }

  if (imageCache.has(url)) {
    const img = imageCache.get(url);
    if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
    return new Promise((resolve, reject) => {
      img.addEventListener('load', () => resolve(img), { once: true });
      img.addEventListener('error', () => reject(new Error(`404: ${url}`)), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    imageCache.set(url, img);
    img.onload  = () => resolve(img);
    img.onerror = () => { imageCache.delete(url); reject(new Error(`404: ${url}`)); };
    img.src = url;
  });
}

/** hex → { r, g, b } */
function hexToRGB(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}

/**
 * 팔레트 스왑 (픽셀 치환)
 * srcMat/srcVer/fromColor: 파일 내 픽셀의 팔레트 (소스)
 * dstMat/dstVer/toColor:   목표 팔레트 (다른 material.version도 허용 — cross-palette)
 */
async function getPaletteSwapped(img, url, srcMat, srcVer, fromColor, dstMat, dstVer, toColor, palettes) {
  const cacheKey = `${url}::${srcMat}.${srcVer}.${fromColor}::${dstMat}.${dstVer}.${toColor}`;
  if (swapCache.has(cacheKey)) return swapCache.get(cacheKey);

  const srcHexArr = palettes?.[srcMat]?.[srcVer]?.[fromColor];
  const dstHexArr = palettes?.[dstMat]?.[dstVer]?.[toColor];
  if (!srcHexArr || !dstHexArr) { swapCache.set(cacheKey, null); return null; }

  const pixelMap = new Map();
  const len = Math.min(srcHexArr.length, dstHexArr.length);
  for (let i = 0; i < len; i++) {
    const src = hexToRGB(srcHexArr[i]);
    const dst = hexToRGB(dstHexArr[i]);
    pixelMap.set((src.r << 16) | (src.g << 8) | src.b, dst);
  }

  const tmp = document.createElement('canvas');
  tmp.width  = img.naturalWidth;
  tmp.height = img.naturalHeight;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.drawImage(img, 0, 0);
  const imageData = tmpCtx.getImageData(0, 0, tmp.width, tmp.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i+3] === 0) continue;
    const key = (data[i] << 16) | (data[i+1] << 8) | data[i+2];
    const dst = pixelMap.get(key);
    if (dst) { data[i] = dst.r; data[i+1] = dst.g; data[i+2] = dst.b; }
  }
  tmpCtx.putImageData(imageData, 0, 0);
  swapCache.set(cacheKey, tmp);
  return tmp;
}

function showError(msg) {
  const el = document.getElementById('render-error');
  if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; }
  if (msg) console.error('[renderer]', msg);
}

// ──────────────────────────────────────────────────────────────────────────────
// buildCharacterSheet
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 선택된 아이템 전체를 분석해 합성 스프라이트시트를 사전 베이크한다.
 *
 * [Phase 1] 각 아이템의 애니메이션 데이터 수집
 *   - 개별 a[animName]: frameSize = 이미지 실제 높이 / dirCount
 *   - a[all]: frameSize = 파일명 파싱값, 행번호 = meta.yOffset / 64
 *
 * [Phase 2] 애니메이션별 최대 frameSize 확정 → 레이아웃 계산 (동적 y 누적)
 *
 * [Phase 3] 이미지 로드 + 팔레트 스왑
 *
 * [Phase 4] 베이크: 각 애니 × 방향 × 프레임에 레이어 합성
 */
export async function buildCharacterSheet() {
  const myVersion = ++_buildVersion;

  const prefixes = Object.keys(state.selections);

  if (prefixes.length === 0) {
    if (myVersion !== _buildVersion) return;
    state.characterSheet = null;
    state.animLayout = {};
    showError('');
    return;
  }

  // ── Phase 1: 아이템별 데이터 수집 ──────────────────────────────────────────
  const prefixData = [];
  for (const prefix of prefixes) {
    const sel  = state.selections[prefix];
    const info = getItemInfo(prefix, state.itemMap);
    // a[all] 여부
    const allData = info['all'] ?? null;
    const allFrameSize = allData ? (allData.frameSize || 64) : null;

    prefixData.push({ prefix, sel, info, allData, allFrameSize });
  }

  // ── Phase 2: 선택 아이템에서 애니 목록 수집 + 레이아웃 ──────────────────
  // 실제 존재하는 애니메이션만 처리 (ANIM_NAMES 상수 불필요)
  // ULPC 표준 순서 유지: ANIM_NAMES 기준 정렬 후 미등록 애니는 뒤에 추가
  const allAnimNames = new Set();
  for (const { info } of prefixData) {
    for (const animName of Object.keys(info)) {
      if (animName !== 'all') allAnimNames.add(animName);
    }
  }
  const sortedAnimNames = [
    ...ANIM_NAMES.filter(n => allAnimNames.has(n)),
    ...[...allAnimNames].filter(n => !ANIM_NAMES.includes(n)).sort(),
  ];

  const animLayout = {};
  let currentY = 0;
  for (const animName of sortedAnimNames) {
    let maxFs = 0, maxFc = 0, maxDirCount = 0, dirsForAnim = null;
    for (const { info, allData, allFrameSize } of prefixData) {
      if (info[animName]) {
        maxFs       = Math.max(maxFs,       info[animName].frameSize  || 64);
        maxFc       = Math.max(maxFc,       info[animName].frameCount || 0);
        maxDirCount = Math.max(maxDirCount, info[animName].dirCount   || 0);
        if (!dirsForAnim && info[animName].dirs) dirsForAnim = info[animName].dirs;
      } else if (allData) {
        maxFs       = Math.max(maxFs, allFrameSize);
        const meta  = ANIM_META[animName];
        if (meta) {
          maxFc       = Math.max(maxFc,       meta.frameCount);
          maxDirCount = Math.max(maxDirCount, meta.dirCount);
        }
        if (!dirsForAnim && allData.dirs) dirsForAnim = allData.dirs;
      }
    }
    if (!maxFs) continue;
    if (!maxFc)       maxFc       = ANIM_META[animName]?.frameCount || 4;
    if (!maxDirCount) maxDirCount = ANIM_META[animName]?.dirCount   || 4;
    animLayout[animName] = {
      startY:       currentY,
      maxFrameSize: maxFs,
      dirCount:     maxDirCount,
      frameCount:   maxFc,
      dirs:         dirsForAnim,
    };
    currentY += maxDirCount * maxFs;
  }

  if (!currentY) {
    state.characterSheet = null;
    state.animLayout = {};
    showError('');
    return;
  }

  // 시트 폭: 가장 넓은 애니(최대 frameCount × maxFrameSize)
  let sheetW = 64;
  for (const [animName, layout] of Object.entries(animLayout)) {
    sheetW = Math.max(sheetW, layout.frameCount * layout.maxFrameSize);
  }

  // ── Phase 3 & 4: 애니메이션별로 이미지 로드 + 베이크 ─────────────────────
  const sheet    = document.createElement('canvas');
  sheet.width    = sheetW;
  sheet.height   = currentY;
  const sheetCtx = sheet.getContext('2d');
  sheetCtx.imageSmoothingEnabled = false;

  const imageBase = state.imageBase ?? '../spritesheets/';

  for (const animName of Object.keys(animLayout)) {
    const layout = animLayout[animName];

    const { startY, maxFrameSize, dirCount, frameCount } = layout;
    const meta      = ANIM_META[animName];
    // all 시트에서 이 애니메이션의 시작 행 번호 (ULPC 표준, 64px 기준)
    // meta가 없는 경우(NinjaAdventure attack/dead 등 ULPC 미등록 애니): 0으로 fallback
    const allStartRow = (meta?.yOffset ?? 0) / 64;

    // 레이어 수집
    const layerDefs = [];
    for (const { sel, info, allData, allFrameSize } of prefixData) {
      let animData = info[animName];
      let fromAll  = false;
      let fileFs   = null;      // 소스 파일의 frameSize

      if (!animData && allData) {
        animData = allData;
        fromAll  = true;
        fileFs   = allFrameSize;
      }
      if (!animData) continue;

      for (const [zPosStr, colorMap] of Object.entries(animData.layers)) {
        const zPos = parseInt(zPosStr);

        // material.version 기준으로 그룹화 — 멀티 material 아이템(예: 글로우소드)은
        // body.ulpc.blue 와 cloth.ulpc.red 가 동시에 렌더링되어야 하므로
        // 그룹마다 독립적으로 하나의 레이어를 추가한다.
        const matGroups = new Map(); // "material.version" → [{color, filePath}]
        for (const [color, fp] of Object.entries(colorMap)) {
          const parsed = parseFilename(fp.split('/').pop());
          const matKey = parsed?.material ? `${parsed.material}.${parsed.version}` : 'default';
          if (!matGroups.has(matKey)) matGroups.set(matKey, []);
          matGroups.get(matKey).push({ color, filePath: fp });
        }

        for (const [matKey, entries] of matGroups.entries()) {
          // 선택값은 풀 ID("metal.ulpc.brass") 또는 단순 색상명("brass")
          const matSelectedFull = sel?.colors?.[matKey] ?? null;
          // 풀 ID에서 단순 색상명 추출 (파일 매칭용)
          let matSelectedColor = matSelectedFull;
          if (matSelectedFull && (matSelectedFull.match(/\./g) || []).length >= 2) {
            matSelectedColor = matSelectedFull.slice(matSelectedFull.lastIndexOf('.') + 1);
          }
          let chosen = entries.find(e => e.color === matSelectedColor);
          if (!chosen) chosen = entries[0];
          // effectiveColor: 스왑 목표 (항상 풀 ID 또는 단순 색상명 그대로)
          const effectiveColor = matSelectedFull ?? chosen.color;
          layerDefs.push({ zPos, filePath: chosen.filePath, fileBaseColor: chosen.color, selectedColor: effectiveColor, fromAll, fileFs });
        }
      }
    }
    if (!layerDefs.length) continue;
    layerDefs.sort((a, b) => a.zPos - b.zPos);

    // 이미지 로드 + 팔레트 스왑
    const readyLayers = [];
    for (const def of layerDefs) {
      if (myVersion !== _buildVersion) return; // 새 빌드가 시작됨 — 현재 빌드 중단
      const url = imageBase + encodeFilePath(def.filePath);
      try {
        const img = await loadImage(url);
        if (myVersion !== _buildVersion) return; // 이미지 로드 중 새 빌드 시작됨

        // 실제 frameSize 결정
        // - all 시트: 파일명 파싱값 (54행 전체이므로 높이/dirCount 불가)
        // - 개별 파일: 실제 이미지 높이 / dirCount
        const actualFs = def.fromAll
          ? (def.fileFs || 64)
          : Math.round(img.naturalHeight / dirCount);

        // 팔레트 스왑
        let source = img;
        if (def.fileBaseColor && def.selectedColor && def.selectedColor !== '__original__' && def.fileBaseColor !== def.selectedColor) {
          const fileParsed = parseFilename(def.filePath.split('/').pop());
          if (fileParsed?.material) {
            // 선택값이 풀 팔레트 ID("all.lpcr.black")인지 단순 색상명("brass")인지 판별
            const selDots = (def.selectedColor.match(/\./g) || []).length;
            let dstMat, dstVer, dstColor;
            if (selDots >= 2) {
              // 풀 ID: "material.version.color"
              const d1 = def.selectedColor.indexOf('.');
              const d2 = def.selectedColor.indexOf('.', d1 + 1);
              dstMat   = def.selectedColor.slice(0, d1);
              dstVer   = def.selectedColor.slice(d1 + 1, d2);
              dstColor = def.selectedColor.slice(d2 + 1);
            } else {
              // 단순 색상명: 파일의 primary palette 사용
              dstMat   = fileParsed.material;
              dstVer   = fileParsed.version;
              dstColor = def.selectedColor;
            }
            // 소스 팔레트: 항상 파일의 primary palette 사용
            // 파일 픽셀은 primary palette 색상이므로 srcMat/srcVer는 파일 파싱값 그대로
            const srcMat = fileParsed.material, srcVer = fileParsed.version;
            const swapped = await getPaletteSwapped(
              img, url, srcMat, srcVer, def.fileBaseColor,
              dstMat, dstVer, dstColor, state.palettes
            );
            if (myVersion !== _buildVersion) return;
            if (swapped) source = swapped;
          }
        }

        readyLayers.push({ ...def, source, actualFs });
      } catch (e) {
        console.warn('[renderer] load failed:', e.message);
      }
    }
    if (!readyLayers.length) continue;

    // 베이크: 방향 × 프레임 × 레이어
    for (let d = 0; d < dirCount; d++) {
      const dstRowY = startY + d * maxFrameSize;

      for (let f = 0; f < frameCount; f++) {
        const dstX = f * maxFrameSize;

        for (const layer of readyLayers) {
          const { source, actualFs, fromAll } = layer;

          // 소스 좌표
          // a[all] walk: all 시트는 프레임 0(idle)이 그대로 남아 있으므로 1프레임 오프셋
          const srcX = (fromAll && animName === 'walk')
            ? (f + 1) * actualFs
            : f * actualFs;
          const srcY = fromAll
            ? (allStartRow + d) * actualFs   // all 시트: 행번호 × frameSize
            : d * actualFs;                  // 개별 파일: 방향 행

          // 범위 초과 방지
          if (srcX + actualFs > source.naturalWidth  ||
              srcX + actualFs > source.width         ||
              srcY + actualFs > source.naturalHeight ||
              srcY + actualFs > source.height) continue;

          // 작은 레이어는 maxFrameSize 기준 중앙 정렬
          const offset = Math.floor((maxFrameSize - actualFs) / 2);
          sheetCtx.drawImage(
            source,
            srcX, srcY, actualFs, actualFs,
            dstX + offset, dstRowY + offset, actualFs, actualFs,
          );
        }
      }
    }
  }

  // 이 빌드가 가장 최신인지 최종 확인 후 state 반영
  if (myVersion !== _buildVersion) return;
  state.characterSheet = sheet;
  state.animLayout     = animLayout;
  showError('');
}

// ──────────────────────────────────────────────────────────────────────────────
// renderCharacter — 동기, 베이크 시트에서 프레임 복사
// ──────────────────────────────────────────────────────────────────────────────

export function renderCharacter(ctx, frameIndex) {
  if (!state.characterSheet || !Object.keys(state.animLayout).length) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    return;
  }

  const animName = state.selectedAnimation || 'walk';
  const layout   = state.animLayout[animName];
  if (!layout) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    return;
  }

  const { startY, maxFrameSize, dirCount, dirs } = layout;
  const isDirless = dirCount === 1;
  const direction = isDirless ? 0 : getDirectionRow(state.selectedDirection ?? 2, dirs, dirCount);
  const zoom      = state.zoomLevel || 3;

  // frameIndex는 advanceFrame()에서 이미 cycle 적용된 실제 열 번호
  const srcX = frameIndex * maxFrameSize;
  const srcY = startY + direction * maxFrameSize;

  const displaySize = Math.round(maxFrameSize * zoom);
  if (ctx.canvas.width !== maxFrameSize || ctx.canvas.height !== maxFrameSize) {
    ctx.canvas.width  = maxFrameSize;
    ctx.canvas.height = maxFrameSize;
  }
  ctx.canvas.style.width  = `${displaySize}px`;
  ctx.canvas.style.height = `${displaySize}px`;
  ctx.clearRect(0, 0, maxFrameSize, maxFrameSize);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    state.characterSheet,
    srcX, srcY, maxFrameSize, maxFrameSize,
    0, 0, maxFrameSize, maxFrameSize,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// renderFullSheet — 다운로드용: 베이크된 characterSheet 반환
// ──────────────────────────────────────────────────────────────────────────────

export async function renderFullSheet() {
  if (!state.characterSheet) {
    await buildCharacterSheet();
  }
  return state.characterSheet;
}
