'use strict';
const fs   = require('fs');
const path = require('path');

// ─── 경로 설정 ───────────────────────────────────────────────────────────────
const ULPC_ROOT   = path.join(__dirname, '../../Universal-LPC-Spritesheet-Character-Generator-master');
const SPRITES_DIR = path.join(ULPC_ROOT, 'spritesheets');
const META_FILE   = path.join(ULPC_ROOT, 'item-metadata.js');
const CREDITS_CSV = path.join(ULPC_ROOT, 'CREDITS.csv');
const OUT_ROOT    = __dirname;
const OUT_SPRITES = path.join(__dirname, '../spritesheets');

// ─── 애니메이션 상수 (sources/state/constants.js 기준) ────────────────────────
const FRAME_SIZE = 64;

// 합성 시트에서 각 애니메이션이 시작하는 픽셀 y 위치
const ANIMATION_OFFSETS = {
  spellcast:   0,
  thrust:      4  * FRAME_SIZE,  // 256
  walk:        8  * FRAME_SIZE,  // 512
  slash:       12 * FRAME_SIZE,  // 768
  shoot:       16 * FRAME_SIZE,  // 1024
  hurt:        20 * FRAME_SIZE,  // 1280
  climb:       21 * FRAME_SIZE,  // 1344
  idle:        22 * FRAME_SIZE,  // 1408
  jump:        26 * FRAME_SIZE,  // 1664
  sit:         30 * FRAME_SIZE,  // 1920
  emote:       34 * FRAME_SIZE,  // 2176
  run:         38 * FRAME_SIZE,  // 2432
  combat_idle: 42 * FRAME_SIZE,  // 2688
  backslash:   46 * FRAME_SIZE,  // 2944
  halfslash:   50 * FRAME_SIZE,  // 3200
  watering:    4  * FRAME_SIZE,  // 256 (thrust 행 공유)
  all:         0,
};

const ANIMATION_NAMES = new Set(Object.keys(ANIMATION_OFFSETS));

// spellcast(4)+thrust(4)+walk(4)+slash(4)+shoot(4)+hurt(1)+climb(1)
// +idle(4)+jump(4)+sit(4)+emote(4)+run(4)+combat_idle(4)+backslash(4)+halfslash(4) = 54
const FULL_SHEET_ROW_COUNT = 54;

const BODY_TYPES = new Set([
  'male', 'female', 'teen', 'child', 'muscular', 'pregnant', 'adult', 'universal',
]);

// ─── PNG 헤더 읽기 ────────────────────────────────────────────────────────────
function readPNGDimensions(filePath) {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  return {
    width:  buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

// 프레임 픽셀 크기 판별: height와 방향 수로 정확히 계산
// dirCount: hurt/climb = 1, 그 외 = 4
function detectFrameSize(width, height, dirCount = 4) {
  if (height && dirCount) {
    const fromHeight = Math.round(height / dirCount);
    // 유효한 프레임 크기 값이면 그대로 사용 (64, 128, 192, 256 ...)
    if (fromHeight >= 64 && width % fromHeight === 0) return fromHeight;
  }
  // fallback: 폭 기반 휴리스틱
  if (width % 64 !== 0) return 64;
  if (width / 64 > 13 && width % 128 === 0) return 128;
  return 64;
}

// 전체 합성 시트 여부 판별 (54행)
function isFullCompositeSheet(width, height) {
  const fSize = detectFrameSize(width);
  return (height / fSize) === FULL_SHEET_ROW_COUNT;
}

// ─── zPos 맵 빌드 ─────────────────────────────────────────────────────────────
// item-metadata.js에서 "layer_N": { "zPos": N, "bodytype": "path/..." } 파싱
// 결과: { "path/to/dir": zPos, ... }
function buildZPosMap(metaContent) {
  const zMap = {};

  // layer 블록은 중첩 {} 없음 → [^}]+ 으로 전체 블록 캡처
  const layerRe = /"layer_\d+"\s*:\s*\{([^}]+)\}/g;
  let m;

  while ((m = layerRe.exec(metaContent)) !== null) {
    const block = m[1];

    const zMatch = block.match(/"zPos"\s*:\s*(-?\d+)/);
    if (!zMatch) continue;
    const zPos = parseInt(zMatch[1]);

    // 슬래시 포함 문자열 값 = 폴더 경로
    const strRe = /:\s*"([a-z0-9_./-]+\/[a-z0-9_./-]*)"/g;
    let sm;
    while ((sm = strRe.exec(block)) !== null) {
      const p = sm[1].replace(/\/$/, ''); // 후행 슬래시 제거
      if (!Object.prototype.hasOwnProperty.call(zMap, p)) {
        zMap[p] = zPos;
      }
    }
  }

  return zMap;
}

// 카테고리별 기본 zPos (item-metadata 파싱 결과 기반 최빈값)
const CATEGORY_Z_DEFAULTS = {
  arms:      60,
  backpack: 110,
  bauldron:  65,
  beards:   111,
  body:       5,
  cape:       5,
  dress:     30,
  eyes:     106,
  facial:   115,
  feet:      15,
  hair:     120,
  hat:      130,
  head:     100,
  legs:      20,
  neck:      81,
  quiver:     8,
  shadow:     0,
  shield:     4,
  shoulders:  60,
  tools:      9,
  torso:     35,
  weapon:   140,
  wrists:    70,
};

// 경로에 대한 zPos 조회 (정확 매칭 → 최장 접두사 매칭 → 카테고리 기본값)
function lookupZPos(lookupPath, zMap) {
  if (Object.prototype.hasOwnProperty.call(zMap, lookupPath)) {
    return zMap[lookupPath];
  }

  let best = '';
  let bestZ = null;
  for (const [p, z] of Object.entries(zMap)) {
    if (lookupPath === p || lookupPath.startsWith(p + '/')) {
      if (p.length > best.length) {
        best = p;
        bestZ = z;
      }
    }
  }
  if (bestZ !== null) return bestZ;

  // 카테고리 기본값 fallback
  const cat = lookupPath.split('/')[0];
  if (Object.prototype.hasOwnProperty.call(CATEGORY_Z_DEFAULTS, cat)) {
    return CATEGORY_Z_DEFAULTS[cat];
  }

  return null; // 완전 미발견
}

// ─── 경로 첫 세그먼트 → 최상단 카테고리 매핑 ─────────────────────────────────
// item-metadata.js categoryTree.children 기준 (10개 최상단)
const PATH_PREFIX_TO_CATEGORY = {
  // body
  body:        'body',
  shadow:      'body',
  wings:       'body',
  tail:        'body',
  wound:       'body',
  prosthesis:  'body',
  // head
  head:        'head',
  neck:        'head',
  eyes:        'head',
  face:        'head',
  eyebrows:    'head',
  ear:         'head',
  nose:        'head',
  // hair
  hair:        'hair',
  beards:      'hair',
  hairext:     'hair',
  // headwear
  hat:         'headwear',
  facial:      'headwear',
  // arms
  arms:        'arms',
  bauldron:    'arms',
  wrists:      'arms',
  shoulders:   'arms',
  // torso
  torso:       'torso',
  dress:       'torso',
  cape:        'torso',
  backpack:    'torso',
  belt:        'torso',
  buckles:     'torso',
  quiver:      'torso',
  // legs
  legs:        'legs',
  // feet
  feet:        'feet',
  // tools
  tools:       'tools',
  // weapons
  shield:      'weapons',
  weapon:      'weapons',
};

// 경로에서 최상단 카테고리 결정
function resolveTopCategory(lookupPath) {
  const prefix = lookupPath.split('/')[0];
  return PATH_PREFIX_TO_CATEGORY[prefix] || prefix; // 미등록 시 원래 prefix 유지
}

// ─── Material 기본 색상 (palette_definitions/*/meta_*.json 기준) ─────────────
// base: 해당 material의 원본(무편집) 스프라이트 기준 색상
const MATERIAL_BASES = {
  metal: { base: 'steel',  version: 'ulpc' },
  body:  { base: 'light',  version: 'ulpc' },
  cloth: { base: 'white',  version: 'ulpc' },
  eye:   { base: 'blue',   version: 'ulpc' },
  hair:  { base: 'orange', version: 'ulpc' },
};

// ─── 방향 인코딩 ──────────────────────────────────────────────────────────────
// 사용자 방향 번호: North=0, South=1, West=2, East=3
// ULPC 시트 행 순서: up(N=0), left(W=2), down(S=1), right(E=3) → "0213"
const DIRLESS_ANIMS = new Set(['hurt', 'climb']);
const DIRS_4 = '0213'; // 4방향 표준 (ULPC 행 순서: N, W, S, E)
const DIRS_1 = '1';    // 단방향 (hurt/climb: South 기준 단일 행)

function getAnimDirs(animName) {
  return DIRLESS_ANIMS.has(animName) ? DIRS_1 : DIRS_4;
}

// ─── item-metadata.js 평가 (recolors 파싱용) ─────────────────────────────────
function loadItemMetadata() {
  let src = fs.readFileSync(META_FILE, 'utf8');
  // export 문을 CommonJS module.exports 로 교체
  src = src.replace(
    /^export\s+\{[^}]+\};?\s*$/m,
    'module.exports = { itemMetadata };'
  );
  const tmpFile = path.join(__dirname, '_tmp_meta_ulpc.cjs');
  fs.writeFileSync(tmpFile, src);
  try {
    delete require.cache[require.resolve(tmpFile)];
    return require(tmpFile).itemMetadata;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── recolor material 맵 빌드 ─────────────────────────────────────────────────
// item-metadata.js 의 각 아이템 layers 경로 → recolors[0].material 매핑
// 반환 예: { "torso/armour/plate/male": "metal", "body/bodies/male": "body", ... }
//
// 일부 아이템(표정 등)의 layer 경로에 ${head} 같은 템플릿 변수가 포함되어 있어
// 실제 파일 경로(예: "head/faces/male/happy")로 조회 시 미스가 발생한다.
// replace_in_path 의 고유 값들로 전개하여 모든 실제 경로를 등록한다.
function _expandTemplateVars(pathStr, replaceInPath) {
  const match = pathStr.match(/\$\{(\w+)\}/);
  if (!match) return [pathStr];
  const varName = match[1];
  const mapping = replaceInPath && replaceInPath[varName];
  if (!mapping || typeof mapping !== 'object') return [pathStr];
  const uniqueValues = [...new Set(Object.values(mapping))];
  const results = [];
  for (const value of uniqueValues) {
    const expanded = pathStr.replace(`\${${varName}}`, value);
    results.push(..._expandTemplateVars(expanded, replaceInPath));
  }
  return results;
}

function buildRecolorMaterialMap() {
  const itemMetadata = loadItemMetadata();
  const map = {};
  for (const item of Object.values(itemMetadata)) {
    if (!Array.isArray(item.recolors) || item.recolors.length === 0) continue;
    if (!item.layers) continue;
    const replaceInPath = item.replace_in_path || {};

    // layer_1 → recolors[0], layer_2 → recolors[1], ...
    // 복수 레이어 + 복수 material 아이템(hair_long_tied 등)에서 각 레이어에 맞는
    // recolor 항목을 매핑한다. 인덱스 초과 시 recolors[0] 으로 폴백.
    const layerEntries = Object.entries(item.layers)
      .sort(([a], [b]) => a.localeCompare(b)); // "layer_1" < "layer_2" 순 정렬

    layerEntries.forEach(([, layer], layerIdx) => {
      const recolor  = item.recolors[layerIdx] || item.recolors[0];
      if (!recolor || !recolor.material) return;
      const material = recolor.material;
      const base     = recolor.base || null; // 예: "ulpc.fur_brown" (아이템별 커스텀 base)

      for (const [key, val] of Object.entries(layer)) {
        if (key === 'zPos' || typeof val !== 'string' || !val.includes('/')) continue;
        // 후행 슬래시 제거 후 템플릿 변수 전개
        const cleanVal = val.replace(/\/$/, '');
        const expandedPaths = _expandTemplateVars(cleanVal, replaceInPath);
        for (const p of expandedPaths) {
          map[p] = { material, base, palettes: recolor.palettes || null };
        }
      }
    });
  }
  return map;
}

// ─── 카테고리 → material 매핑 ────────────────────────────────────────────────
const CATEGORY_TO_MATERIAL = {
  arms:      'metal',
  backpack:  'cloth',
  bauldron:  'metal',
  beards:    'hair',
  body:      'body',
  cape:      'cloth',
  dress:     'cloth',
  eyes:      'eye',
  facial:    'hair',
  feet:      'cloth',
  hair:      'hair',
  hat:       'cloth',
  head:      'cloth',
  legs:      'cloth',
  neck:      'cloth',
  quiver:    'cloth',
  shadow:    'body',
  shield:    'metal',
  shoulders: 'metal',
  tools:     'metal',
  torso:     'cloth',
  weapon:    'metal',
  wrists:    'cloth',
};

// ─── 팔레트 컬러 맵 빌드 ─────────────────────────────────────────────────────
// paletteMetadata에서 { colorName: ["metal.ulpc", "all.lpcr", ...] } 빌드
function buildPaletteColorMaps(metaContent) {
  const palStart = metaContent.indexOf('const paletteMetadata');
  if (palStart === -1) return { colorToPaletteKeys: {} };

  // 섹션 끝: export 또는 파일 끝
  const exportIdx = metaContent.indexOf('\nexport ', palStart);
  const palSection = exportIdx > palStart
    ? metaContent.slice(palStart, exportIdx)
    : metaContent.slice(palStart);

  const colorToPaletteKeys = {}; // { "steel": ["metal.ulpc"], "brown": ["body.ulpc","hair.ulpc",...] }

  const lines = palSection.split('\n');
  let currentMaterial = null;
  let currentVersion  = null;

  for (const line of lines) {
    // material 진입 (4칸 들여쓰기)
    const matMatch = line.match(/^\s{4}"(all|body|cloth|eye|hair|metal)"\s*:/);
    if (matMatch) { currentMaterial = matMatch[1]; currentVersion = null; continue; }
    if (!currentMaterial) continue;

    // version 진입 (8칸 들여쓰기)
    const verMatch = line.match(/^\s{8}"(lpcr|ulpc)"\s*:\s*\{/);
    if (verMatch) { currentVersion = verMatch[1]; continue; }
    if (!currentVersion) continue;

    // 색상 키 (10칸 들여쓰기, hex 배열의 시작)
    const colorMatch = line.match(/^\s{10}"([a-z][a-z0-9_]*)"\s*:\s*\[/);
    if (colorMatch) {
      const colorName = colorMatch[1];
      const key = `${currentMaterial}.${currentVersion}`;
      if (!colorToPaletteKeys[colorName]) colorToPaletteKeys[colorName] = [];
      if (!colorToPaletteKeys[colorName].includes(key)) {
        colorToPaletteKeys[colorName].push(key);
      }
    }
  }

  return { colorToPaletteKeys };
}

// 색상 + 경로 → paletteKey 결정 ("metal.ulpc", "hair.ulpc" 등)
// 여러 팔레트에 속하면 카테고리 기반 우선순위 적용
function resolvePaletteKey(colorName, lookupPath, colorToPaletteKeys) {
  const keys = colorToPaletteKeys[colorName];
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) return keys[0];

  // 카테고리 기반 우선순위
  const category = lookupPath.split('/')[0];
  const preferredMat = CATEGORY_TO_MATERIAL[category];
  if (preferredMat) {
    if (keys.includes(`${preferredMat}.ulpc`)) return `${preferredMat}.ulpc`;
    if (keys.includes(`${preferredMat}.lpcr`)) return `${preferredMat}.lpcr`;
  }
  // all.lpcr 제외하고 가장 구체적인 것 우선
  const nonAll = keys.filter(k => !k.startsWith('all.'));
  if (nonAll.length > 0) return nonAll[0];
  return keys[0];
}

// colorStr (예: "steel", "blue_gray") + 경로 → 파일명용 컬러ID 문자열
// 반환 예: "metal.ulpc.steel", "cloth.ulpc.blue_gray", "metal.ulpc.steel_hair.ulpc.brown"
// "default" → "default" 그대로
//
// noRecolor=true: 이 아이템에 recolor 정의가 없는 경우
//   카테고리 선호 재질(예: weapon→metal)에 이 컬러가 없으면
//   팔레트 스왑 없는 순수 변형 색상으로 처리 → "variant.v1.colorStr"
//   (예: 글로우소드 blue.png/red.png — 팔레트가 아닌 별도 파일이 variant임을 표시)
function resolveColorId(colorStr, lookupPath, colorToPaletteKeys, noRecolor = false) {
  if (colorStr === 'default') return 'default';

  // 전체 문자열 직접 매핑 시도 (e.g. "blue_violet")
  const directKey = resolvePaletteKey(colorStr, lookupPath, colorToPaletteKeys);
  if (directKey) {
    // recolor 미등록 아이템은 팔레트 일치 여부와 무관하게 항상 variant 처리
    if (noRecolor) return `variant.v1.${colorStr}`;
    return `${directKey}.${colorStr}`;
  }

  // 언더바로 분리된 복합 컬러 처리 (e.g. "blue_gray" → blue + gray)
  const parts = colorStr.split('_');
  if (parts.length > 1) {
    // 각 파트의 팔레트 키 목록 교집합 계산
    const keySets = parts.map(p => new Set(colorToPaletteKeys[p] || []));
    const intersection = [...keySets[0]].filter(k => keySets.every(s => s.has(k)));

    if (intersection.length > 0) {
      // 교집합 내에서 카테고리 기반 최적 키 선택
      // 단, all.lpcr만 교집합에 남으면 이중 material 분기로 fallthrough한다.
      // 이유: "bronze_blue" 같은 복합 컬러는 교집합이 all.lpcr 뿐인데,
      // all.lpcr.bronze_blue 는 팔레트에 없는 복합 키 → 이중 material이 올바름.
      const bestKey = (() => {
        const category = lookupPath.split('/')[0];
        const preferredMat = CATEGORY_TO_MATERIAL[category];
        if (preferredMat) {
          if (intersection.includes(`${preferredMat}.ulpc`)) return `${preferredMat}.ulpc`;
          if (intersection.includes(`${preferredMat}.lpcr`)) return `${preferredMat}.lpcr`;
        }
        const nonAll = intersection.filter(k => !k.startsWith('all.'));
        return nonAll.length > 0 ? nonAll[0] : null;
      })();
      // bestKey 팔레트에 복합 컬러가 직접 등록된 경우에만 단일 material 사용
      // 미등록(각 파트만 개별 등록) → 이중 material 분기로 fallthrough
      // 예: bronze_blue: body.ulpc에 bronze·blue 개별 등록되어 bestKey=body.ulpc이지만
      //     body.ulpc에 bronze_blue 복합키는 없음 → 이중 material(metal.ulpc.bronze+cloth.ulpc.blue)
      if (bestKey && colorToPaletteKeys[colorStr]?.includes(bestKey)) {
        return `${bestKey}.${colorStr}`;
      }
      // bestKey 없음 or 복합키 미등록 → 이중 material 분기로 fallthrough
    }

    // 교집합 없음 (또는 all.lpcr만 교집합) → 각 파트를 개별 팔레트로 (이중 material 경우)
    const groups = {};
    for (const p of parts) {
      const key = resolvePaletteKey(p, lookupPath, colorToPaletteKeys);
      if (key) {
        if (!groups[key]) groups[key] = [];
        groups[key].push(p);
      }
    }
    const entries = Object.entries(groups);
    if (entries.length === 1) {
      // 단일 그룹이지만 colorStr 전체가 그 팔레트에 없으면 → variant 처리
      // (예: blonde_2, white_b — 파트 일부가 팔레트 키이나 전체 복합명은 미등록)
      const unknownParts = parts.filter(p => !colorToPaletteKeys[p]);
      if (unknownParts.length > 0) return `variant.v1.${colorStr}`;
      return `${entries[0][0]}.${colorStr}`;
    }
    if (entries.length > 1) {
      return entries.map(([key, colors]) => `${key}.${colors.join('_')}`).join('_');
    }
  }

  // 팔레트 정보 없음 → 색상명만 반환
  return colorStr;
}

// ─── 파일명 컬러 파싱 ─────────────────────────────────────────────────────────
// stem: 확장자·앞 언더스코어 제거된 파일명 기반
// 반환: { color: string, extraParts: string[] }
//   extraParts = 색 앞에 있는 비컬러 접두사 → 파츠로 올라감
function parseColor(stem, colorSet) {
  // 앞 언더스코어: 제거 대신 'u'로 치환 → brown.png와 _brown.png가 다른 파일로 저장됨
  stem = stem.replace(/^_+/, 'u');
  if (!stem) return { color: 'default', extraParts: [] };

  // 정확 매칭
  if (colorSet.has(stem)) return { color: stem, extraParts: [] };

  const segs = stem.split('_');

  // 왼쪽부터 첫 컬러 세그먼트 위치 탐색
  let colorStart = segs.length;
  for (let i = 0; i < segs.length; i++) {
    if (colorSet.has(segs[i])) {
      colorStart = i;
      break;
    }
  }

  // 컬러 없음 → 전체가 파츠명, 파일명 default
  if (colorStart === segs.length) {
    return { color: 'default', extraParts: [stem] };
  }

  // 첫 세그먼트가 컬러 → 전체가 (다중)컬러
  if (colorStart === 0) {
    return { color: stem, extraParts: [] };
  }

  // 접두사(비컬러) + 컬러
  const partName  = segs.slice(0, colorStart).join('_');
  const colorStr  = segs.slice(colorStart).join('_');
  return { color: colorStr, extraParts: [partName] };
}

// ─── 디렉토리 순회 ────────────────────────────────────────────────────────────
function walkDir(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, onFile);
    else if (entry.name.endsWith('.png')) onFile(full);
  }
}

// ─── CREDITS.csv 파서 ────────────────────────────────────────────────────────
// CSV 한 줄을 파싱 (큰따옴표 감싸기 + 닫는따옴표 뒤 공백 지원)
function parseCSVLine(line) {
  const cols = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++; // 앞 공백 건너뜀
    if (i >= line.length) break;
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length && !(line[end] === '"' && line[end + 1] !== '"')) end++;
      cols.push(line.slice(i + 1, end).replace(/""/g, '"').trim());
      i = end + 1;
      while (i < line.length && line[i] === ' ') i++; // 닫는따옴표 뒤 공백 건너뜀
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { cols.push(line.slice(i).trim()); break; }
      cols.push(line.slice(i, end).trim());
      i = end + 1;
    }
  }
  return cols;
}

// CREDITS.csv → 중복 제거된 credits 배열 반환
// URL 집합이 완전히 같은 행끼리만 병합, 나머지는 행 단위 유지
function loadCreditsFromCSV() {
  if (!fs.existsSync(CREDITS_CSV)) return [];
  const lines = fs.readFileSync(CREDITS_CSV, 'utf8').split('\n');
  const groups = new Map(); // urlKey → { authors: Set, licenses: Set, urls: string[] }
  for (const line of lines.slice(1)) { // 헤더 건너뜀
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 5) continue;
    const authors  = cols[2].split(',').map(s => s.trim()).filter(Boolean);
    const licenses = cols[3].split(',').map(s => s.trim()).filter(Boolean);
    const urls     = [...new Set(cols[4].split(',').map(s => s.trim()).filter(Boolean))];
    if (!urls.length) continue;
    const key = [...urls].sort().join('|');
    if (!groups.has(key)) {
      groups.set(key, { authors: new Set(authors), licenses: new Set(licenses), urls: [...urls].sort() });
    } else {
      const g = groups.get(key);
      for (const a of authors)  g.authors.add(a);
      for (const l of licenses) g.licenses.add(l);
    }
  }
  return [...groups.values()].map(g => ({
    authors:  [...g.authors],
    licenses: [...g.licenses],
    urls:     g.urls,
  }));
}

// credits 배열 → { Authors, Licenses, URLs } JSON 구조
function formatCreditsAsJson(credits) {
  const authorsSet   = new Set();
  const licensesSet  = new Set();
  const urls         = [];
  for (const c of credits) {
    for (const a of c.authors)  authorsSet.add(a);
    for (const l of c.licenses) licensesSet.add(l);
    for (const u of c.urls)     urls.push(u);
  }
  return {
    Authors:  [...authorsSet].map(name => ({ name, url: '' })),
    Licenses: [...licensesSet],
    URLs:     [...new Set(urls)].map(url => ({ label: url, url })),
  };
}

// credits 배열 → 사람이 읽기 좋은 txt 문자열
function formatCreditsAsTxt(credits) {
  const SEP  = '='.repeat(80);
  const DASH = '-'.repeat(80);
  const lines = [
    SEP,
    'ULPC Asset Credits',
    'You must credit the following authors when using these assets.',
    SEP,
    '',
  ];
  for (const c of credits) {
    lines.push(`Authors  : ${c.authors.join(', ')}`);
    lines.push(`Licenses : ${c.licenses.join(', ')}`);
    lines.push('URLs     :');
    for (const url of c.urls) lines.push(`  ${url}`);
    lines.push(DASH);
  }
  return lines.join('\n');
}

module.exports = {
  ULPC_ROOT, SPRITES_DIR, META_FILE, CREDITS_CSV, OUT_ROOT, OUT_SPRITES,
  FRAME_SIZE, ANIMATION_OFFSETS, ANIMATION_NAMES,
  FULL_SHEET_ROW_COUNT, BODY_TYPES, CATEGORY_Z_DEFAULTS,
  PATH_PREFIX_TO_CATEGORY, CATEGORY_TO_MATERIAL,
  MATERIAL_BASES, DIRLESS_ANIMS, DIRS_4, DIRS_1, getAnimDirs,
  loadItemMetadata,
  loadCreditsFromCSV, formatCreditsAsTxt, formatCreditsAsJson,
  buildRecolorMaterialMap,
  readPNGDimensions, detectFrameSize, isFullCompositeSheet,
  buildZPosMap, lookupZPos,
  resolveTopCategory,
  buildPaletteColorMaps, resolvePaletteKey, resolveColorId,
  parseColor,
  walkDir,
};
