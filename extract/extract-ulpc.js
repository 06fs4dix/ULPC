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

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const {
  SPRITES_DIR, META_FILE, OUT_ROOT, OUT_SPRITES,
  ANIMATION_NAMES, ANIMATION_OFFSETS, BODY_TYPES,
  MATERIAL_BASES, DIRLESS_ANIMS, getAnimDirs,
  loadCreditsFromCSV, formatCreditsAsTxt, formatCreditsAsJson,
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

function isFullyTransparent(png) {
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] > 0) return false;
  }
  return true;
}

function writePNG(dst, dstPath) {
  if (isFullyTransparent(dst)) { dst.data = null; return false; } // 완전 투명 → 저장 생략
  const dstDir = path.dirname(dstPath);
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(dstPath, PNG.sync.write(dst));
  dst.data = null; // 버퍼 즉시 해제
  return true;
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

// 처음 N 프레임만 잘라냄 (frame 0 유지, 초과 컬럼 제거)
// slash 128px 파일처럼 ULPC 표준 시트 전체 폭(13열)으로 추출됐지만
// 실제 유효 프레임이 6개뿐인 경우에 사용
function cropToFrames(srcPath, dstPath, frameSize, targetFrames) {
  const src       = PNG.sync.read(fs.readFileSync(srcPath));
  const srcCols   = Math.floor(src.width / frameSize);
  const finalCols = Math.min(targetFrames, srcCols);
  if (finalCols >= srcCols) {
    // 자를 필요 없으면 그냥 복사
    const dir = path.dirname(dstPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dstPath, fs.readFileSync(srcPath));
    src.data = null;
    return;
  }
  const newW = finalCols * frameSize;
  const dst  = new PNG({ width: newW, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let col = 0; col < finalCols; col++) {
      const baseX = col * frameSize;
      for (let px = 0; px < frameSize; px++) {
        const si = (y * src.width + baseX + px) * 4;
        const di = (y * newW      + baseX + px) * 4;
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
          else if (e.targetFrames)                                        cropToFrames(e.srcPath, e.dstPath, e.frameSize, e.targetFrames);
          else {
            const srcBuf = fs.readFileSync(e.srcPath);
            const srcPng = PNG.sync.read(srcBuf);
            if (!isFullyTransparent(srcPng)) {
              const dir = path.dirname(e.dstPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(e.dstPath, srcBuf);
            }
            srcPng.data = null;
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
// paletteMetadata 는 미니파이드 한 줄 JSON 이므로 eval 로 파싱
const palettes = {};
{
  let palObj;
  try {
    // "const paletteMetadata = {...};" 형태에서 객체 리터럴만 추출
    const objStr = palSection.replace(/^const paletteMetadata\s*=\s*/, '').replace(/;\s*$/, '').trim();
    palObj = (new Function(`return (${objStr})`))();
  } catch (e) {
    console.error('❌ paletteMetadata 파싱 실패:', e.message);
    process.exit(1);
  }

  // 구조: palObj.materials[material].palettes[version][color] = hex[]
  const materialsMap = palObj.materials || palObj; // 구버전 호환
  for (const [mat, matData] of Object.entries(materialsMap)) {
    const versionsObj = matData.palettes || matData; // 구버전: 바로 version 키
    if (typeof versionsObj !== 'object') continue;
    for (const [ver, colorsObj] of Object.entries(versionsObj)) {
      if (typeof colorsObj !== 'object' || Array.isArray(colorsObj)) continue;
      if (!palettes[mat]) palettes[mat] = {};
      if (!palettes[mat][ver]) palettes[mat][ver] = {};
      for (const [color, hexArr] of Object.entries(colorsObj)) {
        if (!Array.isArray(hexArr)) continue;
        palettes[mat][ver][color] = hexArr.map(h => h.toLowerCase());
      }
    }
  }
}

// all.lpcr.source = metal.ulpc.steel 픽셀값 (cross-palette 스왑 기준점)
// all.lpcr 아이템은 metal.ulpc.steel 픽셀을 그대로 사용하며,
// 뷰어에서 all.lpcr.source → all.lpcr.{targetColor} 스왑으로 75가지 색상을 구현한다.
if (palettes['all']?.['lpcr'] && palettes['metal']?.['ulpc']?.['steel']) {
  palettes['all']['lpcr']['source'] = [...palettes['metal']['ulpc']['steel']];
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
// CREDITS.csv 에서 직접 읽어 URL 집합이 동일한 행끼리만 병합
const credits = loadCreditsFromCSV();
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
  let _recolorPalettes = null; // 멀티 팔레트 포스트 프로세싱용 (임시)

  if (colorStem === null) {
    // 애니메이션명 파일 (hurt.png 등): recolor material 맵에서 base 색상 직접 결정
    // resolveColorId 의 카테고리 기반 우선순위를 우회해 정확한 material.version 사용
    //
    // recolorMaterialMap 키는 디렉터리 단위 ("arms/armour/plate/male") 이므로
    // lookupPath("arms/armour/plate/male/hurt") 대신 preAnimSegs 기반으로 조회한다.
    // postAnimSegs가 있는 경우를 포함해 가장 긴 일치 키를 역순으로 탐색한다.
    let recolorEntry = recolorMaterialMap[lookupPath]; // 기존 방식 먼저 시도
    if (!recolorEntry) {
      for (let end = preAnimSegs.length; end >= 1; end--) {
        const probe = preAnimSegs.slice(0, end).join('/');
        if (recolorMaterialMap[probe]) { recolorEntry = recolorMaterialMap[probe]; break; }
      }
    }
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
      // 팔레트가 여러 버전이면 포스트 프로세싱에서 추가 생성
      if (recolorEntry.palettes && Object.keys(recolorEntry.palettes).length > 1) {
        _recolorPalettes = recolorEntry.palettes;
      }
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
  const cap = ANIM_FRAME_CAPS[animName] ?? null;
  const effectiveFrameCount = (animName === 'walk')              ? (ANIM_FRAME_CAPS.walk)
                            : (PREPEND_ANIMS.has(animName))      ? frameCount + 1
                            : (animName === 'jump')              ? frameCount + 1
                            : (animName === 'backslash')         ? frameCount - 1
                            : (cap !== null && frameCount > cap) ? cap
                            : frameCount;
  const newFilename  = `${colorId}_${frameSize}_${effectiveFrameCount}_${dirs}.png`;

  const newPath = [
    topCategory,
    ...partsWithoutTopPrefix.map(p => `p[${p}]`),
    `a[${animName}]`,
    `z${zPos}`,
    newFilename,
  ].join('/');

  // targetFrames: walk=크롭+frame0제거, 그 외 표준 초과=앞N프레임 크롭
  const needsCrop = cap !== null && frameCount > cap
                    && animName !== 'walk'
                    && !PREPEND_ANIMS.has(animName)
                    && animName !== 'jump'
                    && animName !== 'backslash';
  const targetFrames = animName === 'walk' ? ANIM_FRAME_CAPS.walk
                     : needsCrop           ? effectiveFrameCount
                     : null;
  return { oldPath: relPath, newPath, zPos, yOffset, animName, color: colorId, frameSize, frameCount: effectiveFrameCount, targetFrames, warnings, _recolorPalettes };
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

// ── 멀티 팔레트: 동일 픽셀 파일을 하나로 합쳐 파일명에 팔레트 ID 목록 인코딩 ──────
// 별도 파일 생성 없이 primary 파일명에 추가 팔레트 ID를 '-'로 이어붙임
//
// 예: metal.ulpc.steel (primary) + metal.lpcr.steel + all.lpcr.source
//     → metal.ulpc.steel-metal.lpcr.steel-all.lpcr.source_64_8_0213.png (파일 1개)
//
// 뷰어는 '-' 구분자로 팔레트 ID 목록을 파싱하고, 모든 팔레트의 색상을
// 하나의 컬러픽커에 통합해 표시한다. 선택값은 "material.version.color" 형태의
// 풀 팔레트 ID로 저장되어 renderer가 올바른 cross-palette 스왑을 수행한다.
{
  let merged = 0;
  for (const entry of mapping) {
    if (entry.synthetic || !entry._recolorPalettes) continue;

    const fname  = entry.newPath.split('/').pop().replace(/\.png$/i, '');
    const fparts = fname.split('_');
    if (fparts.length < 4) continue;
    const colorId = fparts.slice(0, fparts.length - 3).join('_');
    const dirs    = fparts[fparts.length - 1];

    // primary palKey 파싱: "metal.ulpc.steel" → palKey="metal.ulpc", base="steel"
    const firstDot  = colorId.indexOf('.');
    const secondDot = colorId.indexOf('.', firstDot + 1);
    if (firstDot < 0 || secondDot < 0) continue;
    const primaryPalKey = colorId.slice(0, secondDot);
    const baseColor     = colorId.slice(secondDot + 1);

    const dirPart = entry.newPath.slice(0, entry.newPath.lastIndexOf('/'));

    // 추가 팔레트 ID 수집
    const extraIds = [];
    for (const [palKey, palColors] of Object.entries(entry._recolorPalettes)) {
      if (palKey === primaryPalKey) continue;

      let extraColor;
      if (palKey.startsWith('all.')) {
        // all.lpcr은 항상 "source" (metal.ulpc.steel 픽셀을 기준점으로 사용)
        extraColor = 'source';
      } else {
        // 해당 팔레트 버전의 base 색상: primary와 동일하면 사용, 없으면 첫 번째
        extraColor = Array.isArray(palColors) && palColors.includes(baseColor)
          ? baseColor
          : (Array.isArray(palColors) && palColors.length > 0 ? palColors[0] : null);
      }
      if (!extraColor) continue;
      extraIds.push(`${palKey}.${extraColor}`);
    }

    if (extraIds.length === 0) continue;

    // primary 파일명에 추가 팔레트 ID를 '-'로 이어붙여 단일 파일로 표현
    const combinedColorId = [colorId, ...extraIds].join('-');
    const newFilename     = `${combinedColorId}_${entry.frameSize}_${entry.frameCount}_${dirs}.png`;
    entry.newPath  = `${dirPart}/${newFilename}`;
    entry.color    = combinedColorId;
    merged++;
  }
  console.log(`  멀티 팔레트 통합: ${merged}개 엔트리 (파일 추가 생성 없음)`);
  // 임시 필드 제거 (mapping.json 에 포함되지 않도록)
  for (const entry of mapping) delete entry._recolorPalettes;
}

// ── 팔레트 색상 파일이 있는 디렉토리의 default 제거 ─────────────────────────
// 같은 디렉토리에 variant.v1.* 또는 팔레트 등록 색상 파일이 있으면 default_* 불필요
// (뷰어에서 X버튼(원본)으로 리컬러 없이 원본 표시 가능하므로 default 파일 불필요)
// default만 있는 디렉토리는 그대로 유지
//
// 확장: 같은 디렉토리뿐 아니라 자식 아이템 경로(p[...] 추가)에도 동일 anim/z로
// 팔레트 색상 파일이 있으면 부모의 default도 제거한다.
// (예: p[adult]/a[spellcast]/z131/default 가 있고,
//      p[adult]/p[cast]/a[spellcast]/z131/white 가 있으면 → default 제거)
{
  // 팔레트 색상 파일 또는 variant가 있는 디렉토리 수집
  const dirsWithPaletteColor = new Set();
  for (const e of mapping) {
    const fname = e.newPath.split('/').pop();
    if (fname.startsWith('default') || fname.startsWith('variant.')) {
      if (fname.startsWith('variant.')) {
        dirsWithPaletteColor.add(e.newPath.substring(0, e.newPath.lastIndexOf('/')));
      }
      continue;
    }
    dirsWithPaletteColor.add(e.newPath.substring(0, e.newPath.lastIndexOf('/')));
  }

  // 자식 경로 감지: 아이템 prefix(a[ 이전) + "a[animName]/zN" 조합으로 색상 파일 보유 여부 색인
  // key: itemPrefix, value: Set<"a[anim]/zN">
  const childPaletteIndex = new Map();
  for (const e of mapping) {
    const fname = e.newPath.split('/').pop();
    if (fname.startsWith('default') || fname.startsWith('variant.')) continue;
    const animIdx = e.newPath.indexOf('/a[');
    if (animIdx < 0) continue;
    const itemPrefix = e.newPath.slice(0, animIdx);
    const zIdx      = e.newPath.indexOf('/z', animIdx);
    const zEnd      = e.newPath.indexOf('/', zIdx + 1);
    if (zIdx < 0) continue;
    const animZ = e.newPath.slice(animIdx + 1, zEnd < 0 ? undefined : zEnd); // "a[spellcast]/z131"
    if (!childPaletteIndex.has(itemPrefix)) childPaletteIndex.set(itemPrefix, new Set());
    childPaletteIndex.get(itemPrefix).add(animZ);
  }

  let removed = 0;
  for (let i = mapping.length - 1; i >= 0; i--) {
    const fname = mapping[i].newPath.split('/').pop();
    if (!fname.startsWith('default')) continue;
    const dir = mapping[i].newPath.substring(0, mapping[i].newPath.lastIndexOf('/'));

    // 기존: 같은 디렉토리에 팔레트 색상 파일 존재
    if (dirsWithPaletteColor.has(dir)) { mapping.splice(i, 1); removed++; continue; }

    // 확장: 자식 아이템 경로에 동일 anim/z 팔레트 색상 파일 존재
    const animIdx = mapping[i].newPath.indexOf('/a[');
    if (animIdx < 0) continue;
    const itemPrefix = mapping[i].newPath.slice(0, animIdx);
    const zIdx      = mapping[i].newPath.indexOf('/z', animIdx);
    const zEnd      = mapping[i].newPath.indexOf('/', zIdx + 1);
    if (zIdx < 0) continue;
    const animZ = mapping[i].newPath.slice(animIdx + 1, zEnd < 0 ? undefined : zEnd);

    let shouldRemove = false;
    for (const [childPrefix, animZSet] of childPaletteIndex) {
      if (childPrefix.startsWith(itemPrefix + '/') && animZSet.has(animZ)) {
        shouldRemove = true;
        break;
      }
    }
    if (shouldRemove) { mapping.splice(i, 1); removed++; }
  }
  console.log(`  팔레트 색상 공존 디렉토리의 default 제거: ${removed}개`);
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
  // 새 형식: '-'로 구분된 복수 팔레트 ID (동일 픽셀, 다른 팔레트 시스템)
  //   예) "metal.ulpc.steel-metal.lpcr.steel-all.lpcr.source"
  // 구 형식: '_'로 구분된 복수 material 그룹 (서로 다른 픽셀 영역)
  //   예) "metal.ulpc.brass_cloth.ulpc.blue"
  // 두 형식 모두 지원: '-' 분리 후 각 세그먼트를 '_' 기반으로 추가 파싱
  const groups = [];
  for (const seg of colorId.split('-')) {
    const tokens = seg.split('_');
    let cur = null;
    for (const tok of tokens) {
      const dots = (tok.match(/\./g) || []).length;
      if (dots >= 2) {
        if (cur) groups.push(cur);
        const d1 = tok.indexOf('.');
        const d2 = tok.indexOf('.', d1 + 1);
        cur = { mat: tok.slice(0, d1), ver: tok.slice(d1 + 1, d2), col: tok.slice(d2 + 1) };
      } else if (cur && dots === 0) {
        cur.col += '_' + tok; // 예: "blue_gray" → color 연속
      }
    }
    if (cur) groups.push(cur);
  }
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
let duped = 0, skippedSame = 0, removedSameDirPixel = 0;
const copyLog = [];
// key: newPath → { dupCount: number, srcPath: string, hash: string|null }
const pathUsed = {};
for (const entry of mapping) {
  if (entry.synthetic) continue;
  entry.srcPath = path.join(SPRITES_DIR, entry.oldPath);
  const key = entry.newPath;
  if (!pathUsed[key]) {
    pathUsed[key] = { dupCount: 0, srcPath: entry.srcPath, hash: null };
    entry.dstPath = path.join(OUT_SPRITES, PROJECT_NAME, key);
  } else {
    // 충돌: 소스 파일 내용 비교 (lazy hash)
    if (pathUsed[key].hash === null) {
      pathUsed[key].hash = crypto.createHash('md5').update(fs.readFileSync(pathUsed[key].srcPath)).digest('hex');
    }
    const h2 = crypto.createHash('md5').update(fs.readFileSync(entry.srcPath)).digest('hex');
    if (pathUsed[key].hash === h2) {
      // 내용 동일 → 복사 건너뜀 (dstPath = null → 워커에서 제외)
      entry.dstPath = null;
      copyLog.push({ status: 'skipped_same', old: entry.oldPath, intended: key });
      skippedSame++;
    } else {
      // 내용 다름 → _dup suffix 유지 (진짜 충돌)
      pathUsed[key].dupCount++;
      const ext = path.extname(key), base = path.basename(key, ext), dir = path.dirname(key);
      const actualRel = `${dir}/${base}_dup${pathUsed[key].dupCount + 1}${ext}`;
      entry.dstPath = path.join(OUT_SPRITES, PROJECT_NAME, actualRel);
      copyLog.push({ status: 'dup', old: entry.oldPath, intended: key, actual: actualRel });
      duped++;
    }
  }
}
// ── 같은 출력 디렉토리 내 다른 이름이지만 픽셀 동일한 파일 제거 ──────────────
// 원인: 소스에 leather.png / walnut.png 처럼 픽셀이 같은 파일이 별개로 존재하거나
//       애니메이션명 파일(base → palette_id)과 색상 파일(white)이 동일 픽셀인 경우.
// 우선순위: palette_id(ulpc/lpcr 포함) > plain_color > variant.v1.*
// 같은 우선순위면 mapping 순서(먼저 처리된 파일)를 유지.
{
  function getSameDirPriority(newPath) {
    const fname = path.basename(newPath);
    if (fname.includes('.ulpc.') || fname.includes('.lpcr.')) return 0; // palette_id
    if (fname.startsWith('variant.'))                                   return 2; // variant
    return 1;                                                                     // plain_color
  }

  // 해시 캐시 (srcPath → md5)
  const hashCache = new Map();
  function srcHash(e) {
    if (!hashCache.has(e.srcPath)) {
      hashCache.set(e.srcPath, crypto.createHash('md5').update(fs.readFileSync(e.srcPath)).digest('hex'));
    }
    return hashCache.get(e.srcPath);
  }

  // 출력 디렉토리별 그룹화 (dstPath가 있는 비합성 항목만)
  const dirMap = new Map(); // outputDir → entry[]
  for (const e of mapping) {
    if (e.synthetic || !e.dstPath) continue;
    const outDir = path.dirname(e.dstPath);
    if (!dirMap.has(outDir)) dirMap.set(outDir, []);
    dirMap.get(outDir).push(e);
  }

  for (const [outDir, entries] of dirMap) {
    if (entries.length < 2) continue;
    // 같은 디렉토리 내 hash → 유지 항목
    const hashWinner = new Map(); // hash → entry (우선순위 승자)
    for (const e of entries) {
      const h = srcHash(e);
      if (!hashWinner.has(h)) {
        hashWinner.set(h, e);
      } else {
        const winner  = hashWinner.get(h);
        const wPri    = getSameDirPriority(winner.newPath);
        const ePri    = getSameDirPriority(e.newPath);
        if (ePri < wPri) {
          // 현재 항목이 더 높은 우선순위 → 기존 winner를 제거
          winner.dstPath = null;
          copyLog.push({ status: 'skipped_same_dir', old: winner.oldPath, kept: e.newPath });
          removedSameDirPixel++;
          hashWinner.set(h, e);
        } else {
          // 현재 항목이 낮거나 같은 우선순위 → 현재 항목 제거
          e.dstPath = null;
          copyLog.push({ status: 'skipped_same_dir', old: e.oldPath, kept: winner.newPath });
          removedSameDirPixel++;
        }
      }
    }
  }
  console.log(`  같은 폴더 내 픽셀 중복 제거: ${removedSameDirPixel}개`);
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
const nonSynthetic = mapping.filter(e => !e.synthetic && e.dstPath != null);

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

    // ── _dup 파일 post-write 중복 제거 ──────────────────────────────────────
    // 원인: 소스 바이트는 달라 사전 dedup 미작동, 프레임 처리 후 출력이 동일한 경우
    //       파일 쓰기 완료 후 실제 output 해시로 비교해 제거
    {
      console.log('\n  _dup 파일 post-cleanup 중...');
      let dupCleaned = 0;

      function walkForDup(dir, results = []) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walkForDup(full, results);
          else if (/_dup\d+\.png$/i.test(e.name)) results.push(full);
        }
        return results;
      }

      const dupFiles = walkForDup(path.join(OUT_SPRITES, PROJECT_NAME));
      for (const dupFile of dupFiles) {
        if (!fs.existsSync(dupFile)) continue;
        const dupHash = crypto.createHash('md5').update(fs.readFileSync(dupFile)).digest('hex');
        const dir = path.dirname(dupFile);
        const siblings = fs.readdirSync(dir).filter(n => !/_dup\d+\.png$/i.test(n) && n.endsWith('.png'));
        let matched = null;
        for (const sib of siblings) {
          const sibHash = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, sib))).digest('hex');
          if (sibHash === dupHash) { matched = sib; break; }
        }
        if (matched) {
          fs.unlinkSync(dupFile);
          copyLog.push({ status: 'removed_dup_postclean', dup: path.basename(dupFile), kept: matched, dir });
          dupCleaned++;
        }
      }
      console.log(`  _dup post-cleanup: ${dupCleaned}개 제거 (총 ${dupFiles.length}개 검사)`);
    }
  } else {
    copied = nonSynthetic.length;
    synthDone = syntheticIdleEntries.length;
  }

  console.log(`\n  복사: ${copied}개 | 합성: ${synthDone}개 | 동일내용 건너뜀(경로충돌): ${skippedSame}개 | 동일내용 건너뜀(같은폴더): ${removedSameDirPixel}개 | 중복(내용다름): ${duped}개 | 오류: ${errors}개`);

  if (copyLog.length > 0) {
    fs.writeFileSync(path.join(OUT_ROOT, 'convert-log.json'), JSON.stringify(copyLog, null, 2), 'utf8');
    console.log('  → convert-log.json 저장 완료');
  }

  const projectDir = path.join(OUT_SPRITES, PROJECT_NAME);
  if (!isDryRun) {
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'palette.json'), JSON.stringify(palettes, null, 2), 'utf8');
    fs.writeFileSync(path.join(projectDir, 'credits.json'), JSON.stringify(formatCreditsAsJson(credits), null, 2), 'utf8');
    console.log(`  → palette.json / credits.json 저장 완료 (spritesheets/${PROJECT_NAME}/)`);
  }

  console.log('\n=== 추출 완료 ===');
  console.log('다음 단계: node build-index.js');
})();
