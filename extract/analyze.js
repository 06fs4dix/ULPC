'use strict';
/**
 * analyze.js
 * spritesheets/ 전체를 순회해 각 파일의 새 경로를 계산, 실제 이동 없이 mapping.json + report.json 출력
 * 실행: node analyze.js
 */
const fs   = require('fs');
const path = require('path');
const {
  SPRITES_DIR, META_FILE, OUT_ROOT,
  ANIMATION_NAMES, ANIMATION_OFFSETS, BODY_TYPES,
  readPNGDimensions, detectFrameSize, isFullCompositeSheet,
  buildZPosMap, lookupZPos,
  resolveTopCategory,
  buildPaletteColorMaps, resolveColorId,
  parseColor, walkDir,
} = require('./lib');

// ── 사전 조건 확인 ─────────────────────────────────────────────────────────────
const colorsPath = path.join(OUT_ROOT, 'colors.json');
if (!fs.existsSync(colorsPath)) {
  console.error('colors.json 없음. 먼저 extract-colors.js를 실행하세요.');
  process.exit(1);
}
const colorSet = new Set(JSON.parse(fs.readFileSync(colorsPath, 'utf8')));
console.log(`컬러 목록 로드: ${colorSet.size}개`);

// ── 팔레트 컬러 맵 빌드 ──────────────────────────────────────────────────────
console.log('item-metadata.js 파싱 중...');
const metaContent = fs.readFileSync(META_FILE, 'utf8');
const zMap = buildZPosMap(metaContent);
console.log(`zPos 맵 엔트리: ${Object.keys(zMap).length}개`);

const { colorToPaletteKeys } = buildPaletteColorMaps(metaContent);
console.log(`팔레트 컬러 엔트리: ${Object.keys(colorToPaletteKeys).length}개`);

// ── 단일 파일 매핑 ────────────────────────────────────────────────────────────
function mapFile(fullPath) {
  const relPath = path.relative(SPRITES_DIR, fullPath).replace(/\\/g, '/');
  const segments = relPath.split('/');

  const filenameFull = segments[segments.length - 1];
  const rawStem      = path.basename(filenameFull, '.png');
  const stem         = rawStem.replace(/^_+/, ''); // 앞 언더스코어 제거
  const dirSegs      = segments.slice(0, -1);

  const warnings = [];

  // lpctools 제외
  if (dirSegs.includes('lpctools')) return null;

  // ── PNG 크기 읽기 (1회만) ─────────────────────────────────────────────────
  const { width, height } = readPNGDimensions(fullPath);
  const frameSize  = detectFrameSize(width);
  const frameCount = width / frameSize;
  const isComposite = isFullCompositeSheet(width, height);

  if (!Number.isInteger(frameCount)) {
    warnings.push(`INVALID_FRAME_COUNT: w=${width} frameSize=${frameSize}`);
  }

  // ── 애니메이션 탐색 ───────────────────────────────────────────────────────
  // 우선순위: 폴더명 (오른쪽→왼쪽) > 파일명 > 전체 합성 시트
  let animName, preAnimSegs, postAnimSegs, colorStem;

  const animInDir = (() => {
    for (let i = dirSegs.length - 1; i >= 0; i--) {
      if (ANIMATION_NAMES.has(dirSegs[i])) return i;
    }
    return -1;
  })();

  if (animInDir >= 0) {
    // 케이스 A: 애니메이션이 폴더명
    animName     = dirSegs[animInDir];
    preAnimSegs  = dirSegs.slice(0, animInDir);
    postAnimSegs = dirSegs.slice(animInDir + 1); // behind, fg, bg 등 후속 폴더
    colorStem    = stem;

  } else if (ANIMATION_NAMES.has(stem)) {
    // 케이스 B: 애니메이션이 파일명 (예: walk.png, backslash.png)
    animName     = stem;
    preAnimSegs  = dirSegs;
    postAnimSegs = [];
    colorStem    = null; // 색 정보 없음 → default

  } else if (isComposite) {
    // 케이스 C: 전체 합성 시트 (54행, adult.png 등)
    animName     = 'all';
    preAnimSegs  = dirSegs;
    postAnimSegs = [];
    colorStem    = stem; // body type이 파일명인 경우 파츠 처리

  } else {
    // 케이스 D: 구조 불명 → all로 처리 후 경고
    warnings.push('UNKNOWN_STRUCTURE');
    animName     = 'all';
    preAnimSegs  = dirSegs;
    postAnimSegs = [];
    colorStem    = stem;
  }

  // ── zPos 조회 ─────────────────────────────────────────────────────────────
  const lookupPath = [...preAnimSegs, ...postAnimSegs].join('/');
  let zPos = lookupZPos(lookupPath, zMap);
  if (zPos === null) {
    warnings.push(`Z_NOT_FOUND: "${lookupPath}"`);
    zPos = 999;
  }

  // ── yOffset (애니메이션별 합성 시트 픽셀 위치, 폴더명에 포함) ───────────────
  const yOffset = ANIMATION_OFFSETS[animName] ?? 0;

  // ── 컬러 파싱 ─────────────────────────────────────────────────────────────
  let color, extraParts;

  if (colorStem === null) {
    // 케이스 B: 파일명이 애니메이션 이름
    color      = 'default';
    extraParts = [];

  } else if (BODY_TYPES.has(colorStem) && animName === 'all') {
    // 케이스 C: body type이 파일명 (예: adult.png) → 파츠로 올리고 default
    color      = 'default';
    extraParts = [colorStem];

  } else {
    const parsed = parseColor(colorStem, colorSet);
    color      = parsed.color;
    extraParts = parsed.extraParts;
  }

  // ── 팔레트 키 해석 → material.version.color 형식 ─────────────────────────
  const colorId = resolveColorId(color, lookupPath, colorToPaletteKeys);

  // ── 새 경로 조립 ──────────────────────────────────────────────────────────
  // preAnimSegs + postAnimSegs + extraParts → 파츠 목록
  // extraParts 중 이미 preAnimSegs에 있는 이름은 중복 제거
  const dedupedExtra = extraParts.filter(p => !preAnimSegs.includes(p) && !postAnimSegs.includes(p));
  const allParts = [...preAnimSegs, ...postAnimSegs, ...dedupedExtra];

  // 최상단 카테고리 결정 (categoryTree 기준 10개)
  const topCategory = resolveTopCategory(lookupPath);

  // 원래 첫 세그먼트가 topCategory와 동일할 때만 제거 (중복 방지)
  // 예: arms→arms (제거), cape→torso (유지: p[cape]로 남김), neck→head (유지: p[neck]로 남김)
  const partsWithoutTopPrefix = allParts[0] === topCategory
    ? allParts.slice(1)
    : allParts;

  const newFilename = `${colorId}_${frameSize}_${frameCount}.png`;

  const newPath = [
    topCategory,
    ...partsWithoutTopPrefix.map(p => `p[${p}]`),
    `a[${animName}]_${yOffset}`,
    `z${zPos}`,
    newFilename,
  ].join('/');

  return {
    oldPath: relPath,
    newPath,
    zPos, yOffset, animName,
    color: colorId, frameSize, frameCount,
    warnings,
  };
}

// ── 전체 파일 처리 ────────────────────────────────────────────────────────────
console.log('\n파일 분석 시작...');
console.log(`소스: ${SPRITES_DIR}`);

const mapping  = [];
const skipped  = [];
let   count    = 0;
let   progress = 0;

walkDir(SPRITES_DIR, (fullPath) => {
  count++;
  if (count % 10000 === 0) {
    progress += 10000;
    process.stdout.write(`  ${progress}개 처리 중...\r`);
  }

  const result = mapFile(fullPath);
  if (!result) {
    skipped.push(path.relative(SPRITES_DIR, fullPath).replace(/\\/g, '/'));
    return;
  }
  mapping.push(result);
});

// ── 중복 경로 탐지 ────────────────────────────────────────────────────────────
const newPathCount = {};
for (const e of mapping) {
  newPathCount[e.newPath] = (newPathCount[e.newPath] || 0) + 1;
}
const duplicates = Object.entries(newPathCount)
  .filter(([, c]) => c > 1)
  .map(([p, c]) => ({ path: p, count: c }));

// 경고 있는 항목
const issues = mapping.filter(e => e.warnings.length > 0);

// ── 결과 출력 ──────────────────────────────────────────────────────────────────
console.log(`\n\n=== 분석 완료 ===`);
console.log(`총 파일:       ${count}개`);
console.log(`매핑됨:        ${mapping.length}개`);
console.log(`제외(lpctools): ${skipped.length}개`);
console.log(`경고:          ${issues.length}개`);
console.log(`중복 경로:     ${duplicates.length}개`);

// ── 파일 저장 ──────────────────────────────────────────────────────────────────
fs.writeFileSync(
  path.join(OUT_ROOT, 'mapping.json'),
  JSON.stringify(mapping, null, 2),
  'utf8'
);
console.log('\nmapping.json 저장 완료');

const report = {
  summary: {
    total:      count,
    mapped:     mapping.length,
    skipped:    skipped.length,
    issues:     issues.length,
    duplicates: duplicates.length,
  },
  issues: issues.map(e => ({
    old:      e.oldPath,
    new:      e.newPath,
    warnings: e.warnings,
  })),
  duplicates,
  skipped,
};
fs.writeFileSync(
  path.join(OUT_ROOT, 'report.json'),
  JSON.stringify(report, null, 2),
  'utf8'
);
console.log('report.json 저장 완료');
