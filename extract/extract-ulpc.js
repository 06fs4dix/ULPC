'use strict';
/**
 * extract-ulpc.js — Step 2: 구버전 ULPC → 새 리소스 폴더
 *
 * 한 번 실행으로 아래를 모두 처리한다.
 *   1. item-metadata.js 에서 컬러 목록 / 팔레트 추출
 *      → colors.json   (색상 이름 목록, 내부용)
 *      → palette.json  (material/version/color → hex[] 팔레트 테이블)
 *   2. 구버전 spritesheets/ 전체 분석 → 새 경로 계산
 *      → mapping.json  (old → new 경로 매핑, 검증용)
 *      → report.json   (경고 / 중복 / 제외 리포트)
 *   3. 새 경로로 파일 복사
 *      → spritesheets/ (새 구조 리소스 폴더)
 *      → convert-log.json (중복 처리 로그, 발생 시만)
 *
 * 실행:
 *   node extract-ulpc.js            # 전체 실행
 *   node extract-ulpc.js --dry-run  # 복사 없이 분석만
 *
 * 이후 Step 3: node build-index.js
 */

const fs   = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const {
  SPRITES_DIR, META_FILE, OUT_ROOT, OUT_SPRITES,
  ANIMATION_NAMES, ANIMATION_OFFSETS, BODY_TYPES,
  MATERIAL_BASES, DIRLESS_ANIMS, getAnimDirs,
  loadItemMetadata,
  buildRecolorMaterialMap,
  readPNGDimensions, detectFrameSize, isFullCompositeSheet,
  buildZPosMap, lookupZPos,
  resolveTopCategory,
  buildPaletteColorMaps, resolveColorId,
  parseColor, walkDir,
} = require('./lib');

const isDryRun    = process.argv.includes('--dry-run');
const PROJECT_NAME = 'ULPC';

// walk 애니메이션 프레임 0(idle 자세) 제거: 첫 번째 열(frameSize px)을 잘라낸다.
const PNG = require('pngjs').PNG;

function writePNG(dst, dstPath) {
  const dstDir = path.dirname(dstPath);
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(dstPath, PNG.sync.write(dst));
  dst.data = null; // 버퍼 즉시 해제
}

// targetFrames: null이면 소스 그대로(-1), 지정하면 그 수로 정규화
//   초과분(예: 13→12→8): 뒤 컬럼 잘라냄
//   부족분(예: 8→7→8):   마지막 프레임 반복 삽입
function cropFirstFrame(srcPath, dstPath, frameSize, targetFrames = null) {
  const src        = PNG.sync.read(fs.readFileSync(srcPath));
  const srcCols    = Math.floor(src.width / frameSize);
  const cropped    = srcCols - 1;                                // frame 0 제거 후 컬럼 수
  const finalCols  = targetFrames != null ? targetFrames : cropped;
  const newW       = finalCols * frameSize;
  const dst        = new PNG({ width: newW, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let dstCol = 0; dstCol < finalCols; dstCol++) {
      const srcCol    = Math.min(dstCol, cropped - 1);           // 부족분: 마지막 프레임 반복
      const srcFrameX = (srcCol + 1) * frameSize;                // +1 = frame 0 건너뜀
      const dstFrameX = dstCol * frameSize;
      for (let px = 0; px < frameSize; px++) {
        const si = (y * src.width  + srcFrameX + px) * 4;
        const di = (y * newW       + dstFrameX + px) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }
  src.data = null;
  writePNG(dst, dstPath);
}

// jump: 특정 프레임을 끝에 복사 추가 (jump는 frame1을 끝에 붙여 [0,1,2,3,4,1_copy] → 순차 재생)
function appendFrame(srcPath, dstPath, frameSize, frameIndex) {
  const src  = PNG.sync.read(fs.readFileSync(srcPath));
  const newW = src.width + frameSize;
  const dst  = new PNG({ width: newW, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      const di = (y * newW + x) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
    for (let x = 0; x < frameSize; x++) {
      const si = (y * src.width + (frameIndex * frameSize + x)) * 4;
      const di = (y * newW + src.width + x) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  src.data = null;
  writePNG(dst, dstPath);
}

// backslash: 특정 프레임 삭제 (frame6 제거 → [0,1,2,3,4,5,7,8,...] → 순차 재생)
function deleteFrame(srcPath, dstPath, frameSize, frameIndex) {
  const src  = PNG.sync.read(fs.readFileSync(srcPath));
  const newW = src.width - frameSize;
  const dst  = new PNG({ width: newW, height: src.height });
  for (let y = 0; y < src.height; y++) {
    let dstX = 0;
    for (let x = 0; x < src.width / frameSize; x++) {
      if (x === frameIndex) continue;
      for (let px = 0; px < frameSize; px++) {
        const si = (y * src.width + (x * frameSize + px)) * 4;
        const di = (y * newW + (dstX * frameSize + px)) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
      dstX++;
    }
  }
  src.data = null;
  writePNG(dst, dstPath);
}

// walk 마지막 프레임을 3번 복사해 idle PNG 합성 (idle 애니메이션이 없는 아이템용)
// walk는 이미 frame0 제거 후 frameCount개 저장됨 → 마지막 열(lastFrame)을 3회 반복
function synthesizeIdleFromWalk(walkDstPath, idleDstPath, frameSize) {
  const src         = PNG.sync.read(fs.readFileSync(walkDstPath));
  const lastFrameX  = src.width - frameSize; // 마지막 프레임 시작 x
  const newW        = 3 * frameSize;         // idle: 3프레임
  const dst         = new PNG({ width: newW, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let f = 0; f < 3; f++) {
      for (let px = 0; px < frameSize; px++) {
        const si = (y * src.width + lastFrameX + px) * 4;
        const di = (y * newW    + f * frameSize + px) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }
  src.data = null;
  writePNG(dst, idleDstPath);
}

// idle/combat_idle 프레임 0 앞에 복사 삽입: [frame0_copy, frame0, frame1, ...]
// → cycle [0,1,2,...] 순차 재생만으로 0-0-1 패턴 달성
function prependFirstFrame(srcPath, dstPath, frameSize) {
  const src  = PNG.sync.read(fs.readFileSync(srcPath));
  const newW = src.width + frameSize;
  const dst  = new PNG({ width: newW, height: src.height });
  for (let y = 0; y < src.height; y++) {
    // 앞에 프레임 0 복사
    for (let x = 0; x < frameSize; x++) {
      const si = (y * src.width + x) * 4;
      const di = (y * newW + x) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
    // 원본 전체를 뒤에 배치
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      const di = (y * newW + x + frameSize) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  src.data = null;
  writePNG(dst, dstPath);
}

// ── 워커 모드: 파일 복사 작업만 수행하고 종료 ──────────────────────────────────
if (!isMainThread) {
  const { copyChunk, synthChunk, wDryRun } = workerData;
  const PROGRESS_INTERVAL = 500; // N파일마다 진행 상황 보고
  if (copyChunk) {
    let copied = 0, errors = 0, reported = 0;
    const log = [];
    for (const e of copyChunk) {
      if (!wDryRun) {
        try {
          if      (e.animName === 'walk')                                 cropFirstFrame(e.srcPath, e.dstPath, e.frameSize, e.targetFrames ?? null);
          else if (e.animName === 'idle' || e.animName === 'combat_idle') prependFirstFrame(e.srcPath, e.dstPath, e.frameSize);
          else if (e.animName === 'jump')                                 appendFrame(e.srcPath, e.dstPath, e.frameSize, 1);
          else if (e.animName === 'backslash')                            deleteFrame(e.srcPath, e.dstPath, e.frameSize, 6);
          else {
            const dir = path.dirname(e.dstPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(e.dstPath, fs.readFileSync(e.srcPath));
          }
          copied++;
        } catch (err) { log.push({ status: 'error', old: e.oldPath, error: err.message }); errors++; }
      } else { copied++; }
      if ((copied + errors) % PROGRESS_INTERVAL === 0) {
        parentPort.postMessage({ type: 'progress', count: PROGRESS_INTERVAL });
        reported += PROGRESS_INTERVAL;
      }
    }
    // done 메시지에는 progress로 아직 보고 안 된 나머지만 포함
    parentPort.postMessage({ type: 'done', copied, errors, copyLog: log, remaining: (copied + errors) - reported });
  }
  if (synthChunk) {
    let synthDone = 0, errors = 0, reported = 0;
    const log = [];
    for (const e of synthChunk) {
      if (!wDryRun) {
        try { synthesizeIdleFromWalk(e.walkDstPath, e.idleDstPath, e.frameSize); synthDone++; }
        catch (err) { log.push({ status: 'error', synthetic: true, intended: e.newPath, error: err.message }); errors++; }
      } else { synthDone++; }
      if ((synthDone + errors) % PROGRESS_INTERVAL === 0) {
        parentPort.postMessage({ type: 'progress', count: PROGRESS_INTERVAL });
        reported += PROGRESS_INTERVAL;
      }
    }
    parentPort.postMessage({ type: 'done', synthDone, errors, copyLog: log, remaining: (synthDone + errors) - reported });
  }
  process.exit(0);
}

console.log('=== ULPC 추출 시작 ===');
if (isDryRun) console.log('[DRY-RUN 모드: 파일 복사 없음]\n');

// ════════════════════════════════════════════════════════════════════════════
// STEP 1 — 컬러 목록 + 팔레트 추출
// ════════════════════════════════════════════════════════════════════════════
console.log('── 1단계: 컬러 / 팔레트 추출 ──');
console.log(`소스: ${META_FILE}`);

const metaContent = fs.readFileSync(META_FILE, 'utf8');

// paletteMetadata 섹션 추출
const palStart = metaContent.indexOf('const paletteMetadata');
if (palStart === -1) {
  console.error('❌ paletteMetadata를 찾을 수 없습니다. item-metadata.js를 확인하세요.');
  process.exit(1);
}
const palEnd     = metaContent.indexOf('\nexport ', palStart);
const palSection = palEnd > palStart ? metaContent.slice(palStart, palEnd) : metaContent.slice(palStart);

// 1-A. colors.json: 색상 이름 목록 (analyze 단계에서 파일명 판별에 사용)
const colorSet   = new Set();
const hexArrayRe = /"([a-z][a-z0-9_]*)"\s*:\s*\[\s*"#[0-9a-fA-F]{6}"/g;
let rxm;
while ((rxm = hexArrayRe.exec(palSection)) !== null) {
  colorSet.add(rxm[1]);
}
console.log(`  컬러 이름: ${colorSet.size}개`);
fs.writeFileSync(path.join(OUT_ROOT, 'colors.json'), JSON.stringify([...colorSet].sort(), null, 2), 'utf8');

// 1-B. palette.json: material/version/color → hex[] 전체 팔레트 테이블
const palettes      = {};
const palLines      = palSection.split('\n');
let curMaterial     = null;
let curVersion      = null;
let curColor        = null;
let inHexArray      = false;

for (const line of palLines) {
  const matMatch = line.match(/^\s{4}"(all|body|cloth|eye|hair|metal)"\s*:/);
  if (matMatch) {
    curMaterial = matMatch[1];
    if (!palettes[curMaterial]) palettes[curMaterial] = {};
    curVersion = null; curColor = null;
    continue;
  }
  if (!curMaterial) continue;

  const verMatch = line.match(/^\s{8}"(lpcr|ulpc)"\s*:\s*\{/);
  if (verMatch) {
    curVersion = verMatch[1];
    if (!palettes[curMaterial][curVersion]) palettes[curMaterial][curVersion] = {};
    continue;
  }
  if (!curVersion) continue;

  const colorMatch = line.match(/^\s{10}"([a-z][a-z0-9_]*)"\s*:\s*\[/);
  if (colorMatch) {
    curColor   = colorMatch[1];
    inHexArray = true;
    palettes[curMaterial][curVersion][curColor] = [];
    const inlineHex = line.match(/#[0-9a-fA-F]{6}/g);
    if (inlineHex) {
      palettes[curMaterial][curVersion][curColor].push(...inlineHex.map(h => h.toLowerCase()));
    }
    if (line.includes(']')) inHexArray = false;
    continue;
  }

  if (inHexArray && curColor) {
    const hexMatch = line.match(/"(#[0-9a-fA-F]{6})"/);
    if (hexMatch) {
      palettes[curMaterial][curVersion][curColor].push(hexMatch[1].toLowerCase());
    }
    if (line.includes(']')) { inHexArray = false; curColor = null; }
  }
}

let totalPalColors = 0;
for (const [mat, vers] of Object.entries(palettes)) {
  for (const [ver, cols] of Object.entries(vers)) {
    const c = Object.keys(cols).length;
    totalPalColors += c;
    console.log(`  ${mat}.${ver}: ${c}개 색상`);
  }
}
console.log(`  팔레트 총 색상 엔트리: ${totalPalColors}개`);
console.log('  → colors.json 저장 완료 (OUT_ROOT)');
console.log('  → palette.json 은 파일 복사 완료 후 저장됩니다.');

// 1-C. credits 추출 (쓰기는 STEP 3에서 palette.json 과 함께)
// URL 하나라도 공유하면 같은 출처로 간주해 union-find 로 병합
const credits = (() => {
  const itemMeta = loadItemMetadata();

  // 1) 모든 credit 엔트리를 flat 배열로 수집
  const raw = [];
  for (const item of Object.values(itemMeta)) {
    if (!Array.isArray(item.credits)) continue;
    for (const credit of item.credits) {
      const urls = Array.isArray(credit.urls) ? credit.urls.filter(Boolean) : [];
      if (!urls.length) continue;
      raw.push({
        authors:   credit.authors  || [],
        licenses:  credit.licenses || [],
        urls,
        fileName:  credit.file || null,
      });
    }
  }

  // 2) union-find
  const parent = raw.map((_, i) => i);
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a, b) { parent[find(a)] = find(b); }

  // URL → 처음 등장한 엔트리 인덱스
  const urlIndex = new Map();
  for (let i = 0; i < raw.length; i++) {
    for (const url of raw[i].urls) {
      if (urlIndex.has(url)) union(i, urlIndex.get(url));
      else urlIndex.set(url, i);
    }
  }

  // 3) 루트별로 병합
  const groups = new Map(); // root → merged entry
  for (let i = 0; i < raw.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { authors: [], licenses: [], urls: new Set(), fileNames: [] });
    const g = groups.get(root);
    for (const a of raw[i].authors)  { if (!g.authors.includes(a))   g.authors.push(a);   }
    for (const l of raw[i].licenses) { if (!g.licenses.includes(l)) g.licenses.push(l); }
    for (const u of raw[i].urls)     { g.urls.add(u); }
    if (raw[i].fileName && !g.fileNames.includes(raw[i].fileName)) g.fileNames.push(raw[i].fileName);
  }

  return [...groups.values()].map(g => ({ authors: g.authors, licenses: g.licenses, urls: [...g.urls].sort() }));
})();
console.log(`  크레딧 고유 출처: ${credits.length}개\n`);

// ════════════════════════════════════════════════════════════════════════════
// STEP 2 — 구버전 파일 분석 (새 경로 계산)
// ════════════════════════════════════════════════════════════════════════════
console.log('── 2단계: 파일 구조 분석 ──');
console.log(`소스: ${SPRITES_DIR}`);

const zMap = buildZPosMap(metaContent);
console.log(`  zPos 맵 엔트리: ${Object.keys(zMap).length}개`);

const { colorToPaletteKeys } = buildPaletteColorMaps(metaContent);
console.log(`  팔레트 컬러 엔트리: ${Object.keys(colorToPaletteKeys).length}개`);

const recolorMaterialMap = buildRecolorMaterialMap();
console.log(`  recolor material 맵 엔트리: ${Object.keys(recolorMaterialMap).length}개`);

function mapFile(fullPath) {
  const relPath  = path.relative(SPRITES_DIR, fullPath).replace(/\\/g, '/');
  const segments = relPath.split('/');

  const filenameFull = segments[segments.length - 1];
  const rawStem      = path.basename(filenameFull, '.png');
  const stem         = rawStem.replace(/^_+/, '');
  const dirSegs      = segments.slice(0, -1);
  const warnings     = [];

  if (dirSegs.includes('lpctools')) return null;

  const { width, height } = readPNGDimensions(fullPath);
  const isComposite = isFullCompositeSheet(width, height);

  // 커스텀 애니메이션 폴더명 → 표준 애니메이션명 매핑
  // 별칭 폴더는 animName으로만 쓰이고, 경로(lookupPath/newPath)에서는 p[...] 파츠로 유지된다.
  const FOLDER_ANIM_ALIASES = {
    'attack_slash':         'slash',      // 192px oversize slash
    'attack_slash_reverse': 'slash',      // 192px reverse slash (longsword)
    'attack_backslash':     'backslash',  // 128px oversize backslash (arming sword 등)
    'attack_halfslash':     'halfslash',  // 128px oversize halfslash
    'attack_thrust':        'thrust',     // 192px oversize thrust (halberd, longsword)
    'cast':                 'spellcast',  // eyes 아이템 일부 폴더명 (eyes/sad2/cast 등)
  };

  let animName, preAnimSegs, postAnimSegs, colorStem;
  // 별칭 폴더가 사용됐을 때: 폴더 자체는 preAnimSegs에 남기고
  // lookupPath / newPath 계산 시 animName을 경로에 삽입하지 않는다.
  let aliasedAnim = false;

  const animInDir = (() => {
    for (let i = dirSegs.length - 1; i >= 0; i--) {
      if (ANIMATION_NAMES.has(dirSegs[i])) return i;
      if (FOLDER_ANIM_ALIASES[dirSegs[i]] !== undefined) return i;
    }
    return -1;
  })();

  if (animInDir >= 0 && FOLDER_ANIM_ALIASES[dirSegs[animInDir]]) {
    // 별칭 폴더: 폴더 자체는 preAnimSegs에 포함(zPos 조회/경로 생성에 사용)
    aliasedAnim  = true;
    animName     = FOLDER_ANIM_ALIASES[dirSegs[animInDir]];
    preAnimSegs  = dirSegs.slice(0, animInDir + 1); // attack_slash 포함
    postAnimSegs = dirSegs.slice(animInDir + 1);
    colorStem    = stem;
  } else if (animInDir >= 0) {
    animName     = dirSegs[animInDir];
    preAnimSegs  = dirSegs.slice(0, animInDir);
    postAnimSegs = dirSegs.slice(animInDir + 1);
    colorStem    = stem;
  } else if (ANIMATION_NAMES.has(stem)) {
    animName     = stem;
    preAnimSegs  = dirSegs;
    postAnimSegs = [];
    colorStem    = null;
  } else if (isComposite) {
    animName     = 'all';
    preAnimSegs  = dirSegs;
    postAnimSegs = [];
    colorStem    = stem;
  } else {
    warnings.push('UNKNOWN_STRUCTURE');
    animName     = 'all';
    preAnimSegs  = dirSegs;
    postAnimSegs = [];
    colorStem    = stem;
  }

  // animName을 항상 lookupPath에 포함 (aliasedAnim 제외).
  // item-metadata.js 레이어 경로는 "weapon/polearm/dragonspear/background/walk" 처럼
  // animation name을 포함하는 경우가 있으므로 항상 삽입해야 정확히 매칭됨.
  // - 단순 아이템: zMap에 "weapon/sword/longsword" → prefix 매칭으로 여전히 동작
  // - background/foreground 분리 아이템: "weapon/.../background/walk" → 정확 매칭 → 올바른 z값
  // - aliasedAnim: 폴더명이 이미 preAnimSegs에 포함되므로 animName 삽입 안 함
  const lookupPath = aliasedAnim
    ? [...preAnimSegs, ...postAnimSegs].join('/')
    : [...preAnimSegs, animName, ...postAnimSegs].join('/');
  let zPos = lookupZPos(lookupPath, zMap);
  if (zPos === null) {
    warnings.push(`Z_NOT_FOUND: "${lookupPath}"`);
    zPos = 999;
  }

  const yOffset = ANIMATION_OFFSETS[animName] ?? 0;

  // animName 확정 후 dirCount를 알 수 있으므로 여기서 frameSize 계산
  const dirCount  = DIRLESS_ANIMS.has(animName) ? 1 : 4;
  const frameSize = detectFrameSize(width, height, dirCount);
  const frameCount = Math.round(width / frameSize);
  if (!Number.isInteger(width / frameSize)) {
    warnings.push(`INVALID_FRAME_COUNT: w=${width} frameSize=${frameSize}`);
  }

  let color, extraParts, colorId;
  if (colorStem === null) {
    // 애니메이션명 파일 (walk.png 등): recolor material 맵에서 base 색상 직접 결정
    // resolveColorId 의 카테고리 기반 우선순위를 우회해 정확한 material.version 사용
    const recolorEntry = recolorMaterialMap[lookupPath];
    const recolorMat   = recolorEntry ? recolorEntry.material : null;
    const matBase      = recolorMat ? MATERIAL_BASES[recolorMat] : null;
    if (matBase) {
      // 아이템별 커스텀 base ("ulpc.fur_brown") 우선, 없으면 MATERIAL_BASES 기본값
      let baseVersion = matBase.version;
      let baseColor   = matBase.base;
      if (recolorEntry.base) {
        const dotIdx = recolorEntry.base.indexOf('.');
        if (dotIdx !== -1) {
          baseVersion = recolorEntry.base.slice(0, dotIdx);           // "ulpc"
          baseColor   = recolorEntry.base.slice(dotIdx + 1);          // "fur_brown"
        }
      }
      color   = baseColor;
      colorId = `${recolorMat}.${baseVersion}.${baseColor}`; // e.g. "body.ulpc.fur_brown"
    } else {
      color   = 'default';
      colorId = 'default';
    }
    extraParts = [];
  } else if (BODY_TYPES.has(colorStem) && animName === 'all') {
    color = 'default'; extraParts = [colorStem];
    colorId = resolveColorId(color, lookupPath, colorToPaletteKeys);
  } else {
    const parsed = parseColor(colorStem, colorSet);
    color = parsed.color; extraParts = parsed.extraParts;
    // 팔레트 미등록 stem이 새 sub-path를 만들 경우 → p[name] 대신 variant.v1.name 처리
    // (예: dark.png, medium.png → p[dark]/default 대신 variant.v1.dark)
    // stem이 preAnimSegs에 이미 있으면 dedupedExtra에서 제거되므로 sub-path 생성 없음 → 제외
    const wouldCreateSubPath = extraParts.some(
      p => !preAnimSegs.includes(p) && !postAnimSegs.includes(p)
    );
    if (wouldCreateSubPath) {
      color      = colorStem;
      colorId    = `variant.v1.${colorStem}`;
      extraParts = [];
    } else {
      const noRecolor = !recolorMaterialMap[lookupPath];
      colorId = resolveColorId(color, lookupPath, colorToPaletteKeys, noRecolor);
      // noRecolor 아이템인데 팔레트 미등록 stem이 경로 중복으로 default가 된 경우
      // (예: dragonspear/background/walk/dragonspear.png → stem='dragonspear'이 preAnimSegs에 있어 dedup → default)
      // → variant.v1.{stem}으로 처리해 default 파일이 생기지 않도록 함
      if (noRecolor && colorId === 'default' && colorStem && colorStem !== 'default') {
        color   = colorStem;
        colorId = `variant.v1.${colorStem}`;
      }
    }
  }

  const dedupedExtra = extraParts.filter(p => !preAnimSegs.includes(p) && !postAnimSegs.includes(p));
  const allParts     = [...preAnimSegs, ...postAnimSegs, ...dedupedExtra];
  const topCategory  = resolveTopCategory(lookupPath);
  const partsWithoutTopPrefix = allParts[0] === topCategory ? allParts.slice(1) : allParts;
  const dirs         = getAnimDirs(animName);
  // walk: 프레임 0 제거 후 표준 프레임 수로 정규화 (초과 자르기 + 부족 패딩)
  // idle/combat_idle: 프레임 0 앞에 복사 삽입 → 저장 프레임 수 +1
  // jump: 프레임 1 끝에 복사 추가 → 저장 프레임 수 +1
  // backslash: 프레임 6 삭제 → 저장 프레임 수 -1
  const PREPEND_ANIMS = new Set(['idle', 'combat_idle']);
  // 애니메이션별 표준 프레임 수 (ANIM_META 기준)
  const ANIM_FRAME_CAPS = {
    walk: 8, spellcast: 7, thrust: 8, slash: 6, shoot: 13,
    hurt: 6, climb: 6, idle: 3, jump: 5, sit: 3, emote: 3,
    run: 8, combat_idle: 2, backslash: 12, halfslash: 6,
  };
  const effectiveFrameCount = (animName === 'walk')              ? (ANIM_FRAME_CAPS.walk)
                            : (PREPEND_ANIMS.has(animName))      ? frameCount + 1
                            : (animName === 'jump')              ? frameCount + 1
                            : (animName === 'backslash')         ? frameCount - 1
                            : frameCount;
  const newFilename  = `${colorId}_${frameSize}_${effectiveFrameCount}_${dirs}.png`;

  const newPath = [
    topCategory,
    ...partsWithoutTopPrefix.map(p => `p[${p}]`),
    `a[${animName}]`,
    `z${zPos}`,
    newFilename,
  ].join('/');

  const targetFrames = animName === 'walk' ? ANIM_FRAME_CAPS.walk : null;
  return { oldPath: relPath, newPath, zPos, yOffset, animName, color: colorId, frameSize, frameCount: effectiveFrameCount, targetFrames, warnings };
}

const mapping = [];
const skipped = [];
let count = 0;

walkDir(SPRITES_DIR, (fullPath) => {
  count++;
  if (count % 10000 === 0) process.stdout.write(`  ${count}개 분석 중...\r`);
  const result = mapFile(fullPath);
  if (!result) {
    skipped.push(path.relative(SPRITES_DIR, fullPath).replace(/\\/g, '/'));
  } else {
    mapping.push(result);
  }
});

// ── variant가 있는 디렉토리의 default 제거 ────────────────────────────────────
// 같은 디렉토리에 variant.v1.* 파일이 있으면 default_* 파일은 불필요
// (뷰어 colorPicker가 variant를 우선 선택하므로 default는 fallback으로 쓰이지 않음)
// default만 있는 디렉토리(6000+개)는 그대로 유지
{
  const dirsWithVariant = new Set();
  for (const e of mapping) {
    if (e.newPath.split('/').pop().startsWith('variant.')) {
      dirsWithVariant.add(e.newPath.substring(0, e.newPath.lastIndexOf('/')));
    }
  }
  let removed = 0;
  for (let i = mapping.length - 1; i >= 0; i--) {
    const fname = mapping[i].newPath.split('/').pop();
    if (fname.startsWith('default')) {
      const dir = mapping[i].newPath.substring(0, mapping[i].newPath.lastIndexOf('/'));
      if (dirsWithVariant.has(dir)) { mapping.splice(i, 1); removed++; }
    }
  }
  console.log(`  variant 공존 디렉토리의 default 제거: ${removed}개`);
}

const newPathCount = {};
for (const e of mapping) newPathCount[e.newPath] = (newPathCount[e.newPath] || 0) + 1;
const duplicates = Object.entries(newPathCount).filter(([, c]) => c > 1).map(([p, c]) => ({ path: p, count: c }));
const issues     = mapping.filter(e => e.warnings.length > 0);

// ── 팔레트 검증: colorId가 palette.json에 실제로 있는지 확인 ─────────────────
// 각 파일의 colorId에서 "material.version.color" 그룹을 파싱해
// palettes 객체에 해당 hex 배열이 있는지 체크한다.
// 없으면 → 뷰어에서 팔레트 스왑 불가 (base 색상 오류 등)
//
// colorId 형식:
//   단일 material: "metal.ulpc.steel"
//   이중 material: "metal.ulpc.brass_cloth.ulpc.blue" (언더바로 구분)
//   → 이중 material은 각 그룹(점 2개 이상 토큰에서 시작)을 독립 검증
function parseColorIdGroups(colorId) {
  // 언더바로 split 후, 점이 2개인 토큰 = 새 그룹 시작
  const tokens = colorId.split('_');
  const groups = [];
  let cur = null;
  for (const tok of tokens) {
    if ((tok.match(/\./g) || []).length === 2) {
      // "material.version.color" 형식 → 새 그룹 시작
      if (cur) groups.push(cur);
      const dotParts = tok.split('.');
      cur = { mat: dotParts[0], ver: dotParts[1], col: dotParts[2] };
    } else if (cur) {
      // 점 없음 → 이전 그룹의 color 연속 (e.g. "blue" + "gray" → "blue_gray")
      cur.col += '_' + tok;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

const paletteErrors = [];
for (const e of mapping) {
  const fname = e.newPath.split('/').pop();
  if (!fname || fname.startsWith('default') || fname.startsWith('variant')) continue;
  // 오른쪽에서 _dirs_frameCount_frameSize 제거 (신형식: 마지막 3토큰)
  const parts = fname.replace(/\.png$/i, '').split('_');
  if (parts.length < 4) continue;
  const colorId = parts.slice(0, parts.length - 3).join('_');
  if (!colorId.includes('.')) continue; // 점 없음 → material 없는 colorId (예: 단순 색상명, 건너뜀)

  const groups = parseColorIdGroups(colorId);
  for (const { mat, ver, col } of groups) {
    if (!palettes[mat] || !palettes[mat][ver] || !palettes[mat][ver][col]) {
      paletteErrors.push({ path: e.newPath, colorId, mat, ver, col, old: e.oldPath });
      break; // 해당 파일에서 첫 번째 오류만 기록
    }
  }
}
if (paletteErrors.length > 0) {
  console.log(`  ⚠ 팔레트 검증 실패: ${paletteErrors.length}개 파일의 colorId가 palette.json에 없음`);
  paletteErrors.slice(0, 5).forEach(e => console.log(`    ${e.colorId} ← ${e.old}`));
  if (paletteErrors.length > 5) console.log(`    ... 외 ${paletteErrors.length - 5}개`);
} else {
  console.log(`  ✅ 팔레트 검증 통과: 모든 colorId가 palette.json에 존재`);
}

// ── walk 있고 idle 없는 아이템에 합성 idle 엔트리 생성 ─────────────────────
// 아이템 prefix = newPath에서 /a[...] 이전 경로
function getItemPrefix(newPath) {
  const idx = newPath.indexOf('/a[');
  return idx >= 0 ? newPath.slice(0, idx) : null;
}

const walkByPrefixZ  = new Map(); // key: "prefix__zN" → walk entry[]
const idlePrefixZSet = new Set(); // key: "prefix__zN"

for (const entry of mapping) {
  const prefix = getItemPrefix(entry.newPath);
  if (!prefix) continue;
  const key = `${prefix}__z${entry.zPos}`;
  if (entry.animName === 'walk')        { if (!walkByPrefixZ.has(key)) walkByPrefixZ.set(key, []); walkByPrefixZ.get(key).push(entry); }
  else if (entry.animName === 'idle')   { idlePrefixZSet.add(key); }
}

const idleYOffset = ANIMATION_OFFSETS['idle']; // 1408
const idleDirs    = getAnimDirs('idle');        // '0213'

const syntheticIdleEntries = [];
for (const [key, walkEntries] of walkByPrefixZ.entries()) {
  if (idlePrefixZSet.has(key)) continue; // 이미 idle 존재
  for (const walkEntry of walkEntries) {
    const prefix      = getItemPrefix(walkEntry.newPath);
    const walkFile    = walkEntry.newPath.split('/').pop();
    // walk 파일명에서 frameCount(예: _8_)를 _3_ 으로 교체
    const idleFile    = walkFile.replace(`_${walkEntry.frameCount}_`, '_3_');
    const idleNewPath = `${prefix}/a[idle]/z${walkEntry.zPos}/${idleFile}`;
    syntheticIdleEntries.push({
      oldPath:     null,
      newPath:     idleNewPath,
      zPos:        walkEntry.zPos,
      yOffset:     idleYOffset,
      animName:    'idle',
      color:       walkEntry.color,
      frameSize:   walkEntry.frameSize,
      frameCount:  3,
      warnings:    ['SYNTHETIC_IDLE'],
      synthetic:   true,
      walkNewPath: walkEntry.newPath,
    });
  }
}
console.log(`  합성 idle 대상: ${syntheticIdleEntries.length}개 (walk 있음 + idle 없음)`);
// mapping에 포함시켜 mapping.json / report에 기록
mapping.push(...syntheticIdleEntries);

console.log(`\n  총 파일: ${count}개 | 매핑: ${mapping.length}개 | 제외: ${skipped.length}개 | 경고: ${issues.length}개 | 중복: ${duplicates.length}개`);

fs.writeFileSync(path.join(OUT_ROOT, 'mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT_ROOT, 'report.json'), JSON.stringify({
  summary: { total: count, mapped: mapping.length, skipped: skipped.length, issues: issues.length, duplicates: duplicates.length, paletteErrors: paletteErrors.length },
  paletteErrors: paletteErrors.slice(0, 100), // 최대 100개만 기록
  issues:  issues.map(e => ({ old: e.oldPath, new: e.newPath, warnings: e.warnings })),
  duplicates,
  skipped,
}, null, 2), 'utf8');
console.log('  → mapping.json / report.json 저장 완료\n');

// ════════════════════════════════════════════════════════════════════════════
// STEP 3 — 파일 복사 (worker_threads 병렬)
// ════════════════════════════════════════════════════════════════════════════
console.log('── 3단계: 파일 복사 ──');

const OUT_SPRITES_PROJECT = path.join(OUT_SPRITES, PROJECT_NAME);
if (!isDryRun && fs.existsSync(OUT_SPRITES_PROJECT)) {
  console.log(`  기존 spritesheets/${PROJECT_NAME}/ 삭제 중...`);
  fs.rmSync(OUT_SPRITES_PROJECT, { recursive: true, force: true });
}

// 메인 스레드에서 srcPath/dstPath 사전 배정 (dedup 포함) → 워커는 그대로 사용
let duped = 0;
const copyLog = [];
const pathUsed = {};
for (const entry of mapping) {
  if (entry.synthetic) continue;
  entry.srcPath = path.join(SPRITES_DIR, entry.oldPath);
  const key = entry.newPath;
  if (pathUsed[key] === undefined) {
    pathUsed[key] = 0;
    entry.dstPath = path.join(OUT_SPRITES, PROJECT_NAME, key);
  } else {
    pathUsed[key]++;
    const ext = path.extname(key), base = path.basename(key, ext), dir = path.dirname(key);
    const actualRel = `${dir}/${base}_dup${pathUsed[key] + 1}${ext}`;
    entry.dstPath = path.join(OUT_SPRITES, PROJECT_NAME, actualRel);
    copyLog.push({ status: 'dup', old: entry.oldPath, intended: key, actual: actualRel });
    duped++;
  }
}
// 합성 idle용 경로도 사전 배정
for (const entry of syntheticIdleEntries) {
  entry.walkDstPath = path.join(OUT_SPRITES, PROJECT_NAME, entry.walkNewPath);
  entry.idleDstPath = path.join(OUT_SPRITES, PROJECT_NAME, entry.newPath);
}

function splitChunks(arr, n) {
  const size = Math.ceil(arr.length / n);
  const out = [];
  for (let i = 0; i < n; i++) { const c = arr.slice(i * size, (i + 1) * size); if (c.length) out.push(c); }
  return out;
}
// 진행 상황을 주기적으로 출력하는 워커 풀 실행
// onProgress(done, total, elapsedSec) 콜백으로 진행률 전달
function runWorkers(chunks, dataKey, total, printLabel) {
  return new Promise((resolve, reject) => {
    let done = 0, workersDone = 0;
    const results = [];
    const t0 = Date.now();

    const printProgress = () => {
      const pct  = total > 0 ? ((done / total) * 100).toFixed(1) : '0.0';
      const sec  = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`  ${printLabel}: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${sec}s\r`);
    };

    const timer = setInterval(printProgress, 2000);

    for (const chunk of chunks) {
      const w = new Worker(__filename, { workerData: { [dataKey]: chunk, wDryRun: false } });
      w.on('message', msg => {
        if (msg.type === 'progress') {
          done += msg.count;
        } else if (msg.type === 'done') {
          done += msg.remaining ?? 0; // progress로 보고 안 된 나머지만 가산
          results.push(msg);
          workersDone++;
          if (workersDone === chunks.length) {
            clearInterval(timer);
            printProgress();
            process.stdout.write('\n');
            resolve(results);
          }
        }
      });
      w.on('error', err => { clearInterval(timer); reject(err); });
      w.on('exit', code => { if (code !== 0) { clearInterval(timer); reject(new Error(`워커 종료: ${code}`)); } });
    }
  });
}

const NUM_WORKERS  = Math.min(os.cpus().length, 8);
const nonSynthetic = mapping.filter(e => !e.synthetic);

(async () => {
  let copied = 0, errors = 0, synthDone = 0;

  if (!isDryRun) {
    // ── 일반 파일 병렬 복사 ──────────────────────────────────────────────────
    const chunks = splitChunks(nonSynthetic, NUM_WORKERS);
    console.log(`  CPU ${NUM_WORKERS}코어 × ${chunks.length}워커로 ${nonSynthetic.length.toLocaleString()}개 복사 시작...`);
    const t0 = Date.now();
    const results = await runWorkers(chunks, 'copyChunk', nonSynthetic.length, '복사');
    for (const r of results) { copied += r.copied; errors += r.errors; copyLog.push(...r.copyLog); }
    console.log(`  복사 완료: ${copied.toLocaleString()}개 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    // ── 합성 idle 병렬 생성 (walk 파일 존재 후) ─────────────────────────────
    if (syntheticIdleEntries.length > 0) {
      const synthChunks = splitChunks(syntheticIdleEntries, NUM_WORKERS);
      console.log(`  합성 idle ${syntheticIdleEntries.length.toLocaleString()}개 생성 시작...`);
      const t1 = Date.now();
      const sr = await runWorkers(synthChunks, 'synthChunk', syntheticIdleEntries.length, '합성');
      for (const r of sr) { synthDone += r.synthDone; errors += r.errors; copyLog.push(...r.copyLog); }
      console.log(`  합성 완료: ${synthDone.toLocaleString()}개 (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    }
  } else {
    copied = nonSynthetic.length;
    synthDone = syntheticIdleEntries.length;
  }

  console.log(`\n  복사: ${copied}개 | 합성: ${synthDone}개 | 중복: ${duped}개 | 오류: ${errors}개`);

  if (copyLog.length > 0) {
    fs.writeFileSync(path.join(OUT_ROOT, 'convert-log.json'), JSON.stringify(copyLog, null, 2), 'utf8');
    console.log('  → convert-log.json 저장 완료');
  }

  const projectDir = path.join(OUT_SPRITES, PROJECT_NAME);
  if (!isDryRun) {
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'palette.json'), JSON.stringify(palettes, null, 2), 'utf8');
    fs.writeFileSync(path.join(projectDir, 'credits.txt'), JSON.stringify(credits, null, 2), 'utf8');
    console.log(`  → palette.json / credits.txt 저장 완료 (spritesheets/${PROJECT_NAME}/)`);
  }

  console.log('\n=== 추출 완료 ===');
  console.log('다음 단계: node build-index.js');
})();
