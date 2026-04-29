/**
 * loader.js — index.json 로드 및 트리/아이템맵 빌드
 */

// 최상단 카테고리 목록 (프로젝트 접두어와 구별용)
const KNOWN_CATEGORIES = new Set([
  'arms','body','hair','head','headwear','legs','feet','tools','torso','weapons',
]);

/**
 * index.json 경로에서 프로젝트 접두어 자동 감지
 * 첫 번째 파일의 첫 세그먼트가 알려진 카테고리가 아니면 프로젝트 접두어로 판단
 * 반환: 'ULPC/' 형태의 문자열, 또는 '' (접두어 없음)
 */
export function detectPathPrefix(files) {
  if (!files || files.length === 0) return '';
  const firstSeg = files[0].split('/')[0];
  if (KNOWN_CATEGORIES.has(firstSeg)) return ''; // 구버전 형식 (접두어 없음)
  return firstSeg + '/';
}

export async function loadIndex(indexUrl = '../index.json', filterPrefix = null) {
  const res = await fetch(indexUrl);
  if (!res.ok) throw new Error(`Failed to load index.json: ${res.status}`);
  const idx = await res.json();

  // filterPrefix 지정 시 해당 프로젝트 파일만 사용
  const allFiles = idx.files;
  const files    = filterPrefix
    ? allFiles.filter(f => f.startsWith(filterPrefix + '/'))
    : allFiles;

  const skip = filterPrefix ? 1 : (detectPathPrefix(files) ? 1 : 0);

  return {
    tree:       buildTree(files, skip),
    itemMap:    buildItemMap(files, skip),
    palettes:   idx.palettes,
    files,
    totalFiles: allFiles.length,
    pathPrefix: filterPrefix ? filterPrefix + '/' : detectPathPrefix(allFiles),
  };
}

/**
 * index.json에서 프로젝트 목록 자동 감지
 * files[] 첫 세그먼트가 알려진 카테고리가 아니면 프로젝트명으로 판단
 * 반환: [{ id, label }]
 */
export async function detectProjects(indexUrl) {
  const res = await fetch(indexUrl);
  if (!res.ok) throw new Error(`Failed to load index.json: ${res.status}`);
  const idx = await res.json();

  const seen = new Set();
  for (const f of (idx.files || [])) {
    const seg = f.split('/')[0];
    if (seg && !KNOWN_CATEGORIES.has(seg)) seen.add(seg);
  }
  return [...seen].sort().map(id => ({ id, label: id }));
}

/**
 * files[] → 중첩 트리 객체 (a[ 이전 세그먼트까지)
 * skipSegments: 앞에서 건너뛸 세그먼트 수 (프로젝트 접두어용)
 * 반환 구조: { "arms": { "p[armour]": { "p[plate]": { "p[female]": {} } } }, ... }
 */
export function buildTree(files, skipSegments = 0) {
  const root = {};
  for (const f of files) {
    const segs = f.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    let node = root;
    for (let i = skipSegments; i < aIdx; i++) {
      const seg = segs[i];
      if (!node[seg]) node[seg] = {};
      node = node[seg];
    }
  }
  return root;
}

/**
 * files[] → prefix → 해당 파일 목록
 * prefix = 프로젝트 접두어 제외, a[ 이전 세그먼트들을 '/'로 join한 문자열
 * 예: "arms/p[armour]/p[plate]/p[female]"
 * 주의: map 값(files[])은 pathPrefix 포함된 원본 전체 경로 저장
 */
export function buildItemMap(files, skipSegments = 0) {
  const map = {};
  for (const f of files) {
    const segs = f.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    const prefix = segs.slice(skipSegments, aIdx).join('/');
    if (!map[prefix]) map[prefix] = [];
    map[prefix].push(f);
  }
  return map;
}

/**
 * 선택된 prefix 의 파일들을 파싱해
 * animName → { yOffset, layers: { zPos: { color: filePath } } } 반환
 */
export function getItemInfo(prefix, itemMap) {
  const files = itemMap[prefix];
  if (!files) return {};
  const byAnim = {};
  // (animName::zPos::color) → frameCount: 같은 키에 여러 파일이 있을 때 더 많은 프레임을 가진 파일 유지
  const layerFc = {};

  for (const f of files) {
    const segs = f.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    const animSeg = segs[aIdx];
    const m = animSeg.match(/^a\[(.+)\]$/);
    if (!m) continue;
    const animName = m[1];
    const zPosStr  = segs[aIdx + 1];
    const zPos     = parseInt(zPosStr.replace('z', ''));
    const fname    = segs[aIdx + 2];
    if (!fname) continue;
    const parsed   = parseFilename(fname);
    if (!parsed) continue;
    const { color, frameSize, frameCount, dirs } = parsed;
    const dirCount = dirs ? dirs.length : 4;

    if (!byAnim[animName]) {
      byAnim[animName] = { frameSize, frameCount, dirCount, dirs, layers: {} };
    } else {
      if (frameSize  > byAnim[animName].frameSize)  byAnim[animName].frameSize  = frameSize;
      if (frameCount > byAnim[animName].frameCount) byAnim[animName].frameCount = frameCount;
      if (dirCount   > byAnim[animName].dirCount)   byAnim[animName].dirCount   = dirCount;
      if (!byAnim[animName].dirs && dirs)            byAnim[animName].dirs       = dirs;
    }
    if (!byAnim[animName].layers[zPos]) {
      byAnim[animName].layers[zPos] = {};
    }
    // 같은 (anim, z, color)에 여러 파일이 있으면 프레임 수가 더 많은 파일 유지
    const fcKey = `${animName}::${zPos}::${color}`;
    if (!layerFc[fcKey] || frameCount >= layerFc[fcKey]) {
      byAnim[animName].layers[zPos][color] = f;
      layerFc[fcKey] = frameCount;
    }
  }
  return byAnim;
}

/**
 * 파일명 파싱
 * 신규 형식: "metal.ulpc.brass_64_6_0213.png" → { material, version, color, frameSize, frameCount, dirs }
 * 구형식:   "metal.ulpc.brass_64_6.png"       → dirs = null
 *
 * 파싱 규칙 (오른쪽부터):
 *   1. 마지막 토큰이 순수 정수이고 바로 앞도 순수 정수이며 그게 64|128 → 구형식 (dirs 없음)
 *   2. 위 조건 불만족 → 마지막 토큰이 dirs, 그 앞이 frameCount, 그 앞이 frameSize
 */
export function parseFilename(fname) {
  const noext = fname.replace(/\.png$/i, '');
  const tokens = noext.split('_');
  if (tokens.length < 2) return null;

  let frameCount, frameSize, dirs, rest;

  // 구형식 감지: 마지막 두 토큰이 정수이고 끝에서 두 번째가 64|128
  const last  = parseInt(tokens[tokens.length - 1]);
  const prev  = parseInt(tokens[tokens.length - 2]);
  if (!isNaN(last) && (prev === 64 || prev === 128)) {
    // 구형식: no dirs
    const t = [...tokens];
    frameCount = parseInt(t.pop());
    frameSize  = parseInt(t.pop());
    dirs = null;
    rest = t.join('_');
  } else {
    // 신규 형식: dirs가 마지막
    const t = [...tokens];
    dirs       = t.pop();
    frameCount = parseInt(t.pop());
    frameSize  = parseInt(t.pop());
    if (isNaN(frameCount) || isNaN(frameSize)) return null;
    // dirs 유효성: 0-3 숫자만 허용 (_dup2 등 이상 파일 차단)
    if (!/^[0-3]+$/.test(dirs)) return null;
    rest = t.join('_');
  }

  if (!rest) return null;

  const dotIdx = rest.indexOf('.');
  // dot 없는 경우: "default" → material=null, version=null, color=rest
  if (dotIdx < 0) {
    return { material: null, version: null, color: rest, frameSize, frameCount, dirs };
  }
  const dot2 = rest.indexOf('.', dotIdx + 1);
  if (dot2 < 0) return null;

  const material = rest.slice(0, dotIdx);
  const version  = rest.slice(dotIdx + 1, dot2);
  const color    = rest.slice(dot2 + 1); // 복합 컬러(blue_gray) 그대로 유지

  return { material, version, color, frameSize, frameCount, dirs };
}

/**
 * 아이템 prefix 에서 머티리얼 그룹별 사용 가능한 컬러 목록 반환
 *
 * 확장 규칙:
 * - material 그룹이 1개뿐인 아이템 → 팔레트 전체 컬러로 확장 (base + swap 방식)
 * - material 그룹이 2개 이상인 아이템 → 각 그룹을 독립적으로 팔레트 확장
 *   (고정 색상 파트는 선택 목록에서 제외)
 *
 * 반환: [{ material, version, colors: string[], fileColors: string[] }]
 *   - colors: 선택 가능한 전체 색상 목록 (팔레트 확장 포함)
 *   - fileColors: 실제 파일에 존재하는 색상 (초기값 설정용)
 */
export function getAvailableColors(prefix, itemMap, palettes) {
  const files = itemMap[prefix];
  if (!files) return [];

  // 파일들에서 material.version별 실제 컬러 Set 수집
  const groupFileColors = new Map(); // "material.version" → Set<color>
  let hasDefault = false;

  for (const f of files) {
    const segs = f.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    const fname = segs[aIdx + 2];
    if (!fname) continue;
    const parsed = parseFilename(fname);
    if (!parsed) continue;
    if (!parsed.material) {
      hasDefault = true;
    } else {
      const key = `${parsed.material}.${parsed.version}`;
      if (!groupFileColors.has(key)) groupFileColors.set(key, new Set());
      groupFileColors.get(key).add(parsed.color);
    }
  }

  // material 그룹이 없으면 default만 반환
  if (groupFileColors.size === 0) {
    return hasDefault ? [{ material: null, version: null, colors: ['default'], fileColors: ['default'] }] : [];
  }

  // 단일 material 그룹이면 팔레트 전체 확장 가능
  const canExpand = groupFileColors.size === 1;

  // 복수 material이라도 모든 그룹이 단일 색상 파일이면 각 그룹을 팔레트 전체로 확장 가능
  // (예: 글로우소드 body.ulpc.blue + cloth.ulpc.red — 각각 독립 recolor 가능)
  const hasMultiColorGroup = [...groupFileColors.values()].some(s => s.size > 1);

  const result = [];

  for (const [key, colorSet] of groupFileColors) {
    const dotIdx = key.indexOf('.');
    const material = key.slice(0, dotIdx);
    const version  = key.slice(dotIdx + 1);
    const paletteColors = palettes?.[material]?.[version];

    let colorsToAdd;
    if (canExpand && paletteColors) {
      // 단일 material: 팔레트 전체로 확장 (1개 파일이라도 swap으로 모든 컬러 지원)
      colorsToAdd = Object.keys(paletteColors);
    } else if (colorSet.size > 1) {
      // 복수 material 중 실제 여러 색상 파일이 있는 그룹 → 파일 색상만 표시
      colorsToAdd = [...colorSet];
    } else if (!hasMultiColorGroup) {
      // 복수 material이고 모든 그룹이 단일 색상 파일만 있는 경우 (예: 글로우소드)
      // 스프라이트 픽셀이 팔레트와 일치하지 않아 swap 불가 → 실제 파일 색상만 표시
      colorsToAdd = [...colorSet];
    } else {
      // 복수 material + 다른 그룹에 여러 색상 파일이 있음 → 고정 색상 파트는 목록 제외
      continue;
    }

    result.push({
      material,
      version,
      colors: [...colorsToAdd].sort((a, b) => a.localeCompare(b)),
      fileColors: [...colorSet],  // 실제 파일에 존재하는 색상 (초기값 설정용)
    });
  }

  return result;
}

/**
 * Body type 키워드 목록 (경로의 p[...] 에 포함될 수 있는 값)
 */
export const BODY_TYPES = ['male', 'female', 'adult', 'child', 'teen', 'muscular', 'pregnant', 'universal'];

/**
 * 세그먼트 표시명 변환
 * "p[armour]" → "armour"
 * "arms"      → "Arms"
 */
export function displayName(seg) {
  if (seg.startsWith('p[') && seg.endsWith(']')) {
    return seg.slice(2, -1);
  }
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * 노드가 리프(선택 가능한 아이템)인지 판별
 */
export function isLeaf(node) {
  return typeof node === 'object' && Object.keys(node).length === 0;
}
