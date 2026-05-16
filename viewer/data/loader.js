/**
 * loader.js — index.json / index.json.gz 로드 및 트리/아이템맵 빌드
 */

// 최상단 카테고리 목록 (프로젝트 접두어와 구별용)
const KNOWN_CATEGORIES = new Set([
  'arms','body','hair','head','headwear','legs','feet','tools','torso','weapons',
]);

/**
 * URL에서 JSON을 fetch한다.
 * .gz 확장자면 DecompressionStream으로 gzip 해제 후 파싱.
 * 일반 URL이면 .gz를 먼저 시도하고, 없으면 원본 URL로 fallback.
 */
async function fetchJson(url) {
  if (url.endsWith('.gz')) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const ds         = new DecompressionStream('gzip');
    const decompressed = res.body.pipeThrough(ds);
    const text       = await new Response(decompressed).text();
    return JSON.parse(text);
  }

  // .gz 먼저 시도
  const gzRes = await fetch(url + '.gz');
  if (gzRes.ok) {
    const ds         = new DecompressionStream('gzip');
    const decompressed = gzRes.body.pipeThrough(ds);
    const text       = await new Response(decompressed).text();
    return JSON.parse(text);
  }

  // fallback: 원본 json
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

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

/**
 * 파싱된 index 데이터 객체에서 tree/itemMap을 빌드하고 결과 반환
 * (loadIndex 내부, zip-loader 공유)
 *
 * 최적화: 파일명 파싱을 1회만 수행하고, expand 로직에서 재활용
 */
export function processIndexData(idx) {
  const files   = idx.files;
  const tree    = buildTree(files, 0);
  const itemMap = buildItemMapAndExpand(files, 0, tree);
  return {
    tree,
    itemMap,
    palettes:   idx.palettes,
    files,
    totalFiles: files.length,
    pathPrefix: '',
  };
}

/**
 * buildItemMap + expandMultiColorLeaves + expandMultiMaterialLeaves 통합 (1-pass 파싱)
 */
function buildItemMapAndExpand(files, skipSegments, tree) {
  const map = {};
  // prefix별 메타: 파싱 결과를 분류해 저장
  const prefixMeta = {}; // prefix → { nullColors: Map<color, file[]>, matGroups: Map<matKey, file[]>, matFiles: file[] }

  for (const f of files) {
    const segs = f.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    const prefix = segs.slice(skipSegments, aIdx).join('/');
    if (!map[prefix]) {
      map[prefix] = [];
      prefixMeta[prefix] = { nullColors: new Map(), matGroups: new Map(), matFiles: [] };
    }
    map[prefix].push(f);

    // 파일명 1회 파싱
    const fname = segs[aIdx + 2];
    if (!fname) continue;
    const parsed = parseFilename(fname);
    if (!parsed) continue;

    const meta = prefixMeta[prefix];
    if (parsed.material === null) {
      let arr = meta.nullColors.get(parsed.color);
      if (!arr) { arr = []; meta.nullColors.set(parsed.color, arr); }
      arr.push(f);
    } else {
      const matKey = `${parsed.material}.${parsed.version}`;
      let arr = meta.matGroups.get(matKey);
      if (!arr) { arr = []; meta.matGroups.set(matKey, arr); }
      arr.push(f);
      meta.matFiles.push(f);
    }
  }

  // ── expandMultiColorLeaves (pre-grouped 데이터 활용) ──
  for (const prefix of Object.keys(prefixMeta)) {
    const meta = prefixMeta[prefix];
    if (meta.nullColors.size <= 1) continue;

    const prefixSegs = prefix.split('/');
    let node = tree, valid = true;
    for (const seg of prefixSegs) {
      if (!node || !Object.prototype.hasOwnProperty.call(node, seg)) { valid = false; break; }
      node = node[seg];
    }
    if (!valid || typeof node !== 'object') continue;

    for (const colorName of meta.nullColors.keys()) {
      node[colorName] = {};
    }
    for (const [colorName, colorFiles] of meta.nullColors) {
      map[`${prefix}/${colorName}`] = colorFiles;
    }
    if (meta.matFiles.length > 0) {
      map[prefix] = meta.matFiles;
    } else {
      delete map[prefix];
    }
  }

  // ── expandMultiMaterialLeaves (pre-grouped 데이터 활용) ──
  for (const prefix of Object.keys(prefixMeta)) {
    const meta = prefixMeta[prefix];
    if (meta.matGroups.size <= 1) continue;

    const prefixSegs = prefix.split('/');
    let node = tree, valid = true;
    for (const seg of prefixSegs) {
      if (!node || !Object.prototype.hasOwnProperty.call(node, seg)) { valid = false; break; }
      node = node[seg];
    }
    if (!valid || typeof node !== 'object') continue;
    if (Object.keys(node).length > 0) continue;

    for (const matKey of meta.matGroups.keys()) {
      node[matKey] = {};
    }
    for (const [matKey, groupFiles] of meta.matGroups) {
      map[`${prefix}/${matKey}`] = groupFiles;
    }
    delete map[prefix];
  }

  return map;
}

export async function loadIndex(indexUrl) {
  const idx = await fetchJson(indexUrl);
  return processIndexData(idx);
}

/**
 * index.json에서 프로젝트 목록 자동 감지
 * files[] 첫 세그먼트가 알려진 카테고리가 아니면 프로젝트명으로 판단
 * 반환: [{ id, label }]
 */
export async function detectProjects(indexUrl) {
  const idx = await fetchJson(indexUrl);

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
    const t = [...tokens];
    frameCount = parseInt(t.pop());
    frameSize  = parseInt(t.pop());
    dirs = null;
    rest = t.join('_');
  } else {
    const t = [...tokens];
    dirs       = t.pop();
    frameCount = parseInt(t.pop());
    frameSize  = parseInt(t.pop());
    if (isNaN(frameCount) || isNaN(frameSize)) return null;
    if (!/^[0-3]+$/.test(dirs)) return null;
    rest = t.join('_');
  }

  if (!rest) return null;

  const dotIdx = rest.indexOf('.');
  // dot 없는 경우: "default" → material=null
  if (dotIdx < 0) {
    return { material: null, version: null, color: rest, frameSize, frameCount, dirs, palettes: null };
  }
  const dot2 = rest.indexOf('.', dotIdx + 1);
  if (dot2 < 0) return null;

  // '-' 포함 여부로 멀티 팔레트 형식 판별
  // 멀티 팔레트: "metal.ulpc.steel-metal.lpcr.steel-all.lpcr.source"
  // 단일 팔레트: "metal.ulpc.steel" 또는 "metal.ulpc.blue_gray"
  if (rest.includes('-')) {
    const palettes = rest.split('-').map(seg => {
      const d1 = seg.indexOf('.');
      if (d1 < 0) return null;
      const d2 = seg.indexOf('.', d1 + 1);
      if (d2 < 0) return null;
      return { material: seg.slice(0, d1), version: seg.slice(d1 + 1, d2), color: seg.slice(d2 + 1) };
    }).filter(Boolean);
    if (palettes.length === 0) return null;
    const primary = palettes[0];
    return { ...primary, frameSize, frameCount, dirs, palettes };
  }

  const material = rest.slice(0, dotIdx);
  const version  = rest.slice(dotIdx + 1, dot2);
  const color    = rest.slice(dot2 + 1); // 복합 컬러(blue_gray) 그대로 유지
  return { material, version, color, frameSize, frameCount, dirs, palettes: null };
}


/**
 * 아이템 prefix 에서 머티리얼 그룹별 사용 가능한 컬러 목록 반환
 *
 * 멀티 팔레트 파일(예: metal.ulpc.steel-metal.lpcr.steel-all.lpcr.source_...)은
 * 파일명에 내포된 모든 팔레트 그룹의 색상을 각각 독립 항목으로 반환한다.
 * 모든 그룹은 같은 파일을 공유하며, 색상 선택값은 "material.version.color" 풀 ID로 저장된다.
 *
 * 반환: [{ material, version, colors: string[], fileColors: string[] }]
 */
export function getAvailableColors(prefix, itemMap, palettes) {
  const files = itemMap[prefix];
  if (!files) return [];

  const groupFileColors = new Map(); // "material.version" → Set<color>
  const rawColors = new Set();
  // 멀티 팔레트 파일에 내포된 추가 팔레트 그룹 (파일 별도 없음)
  const extraGroups = new Map();     // "material.version" → baseColor

  for (const f of files) {
    const segs = f.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    const fname = segs[aIdx + 2];
    if (!fname) continue;
    const parsed = parseFilename(fname);
    if (!parsed) continue;
    if (!parsed.material) {
      rawColors.add(parsed.color);
    } else {
      const key = `${parsed.material}.${parsed.version}`;
      if (!groupFileColors.has(key)) groupFileColors.set(key, new Set());
      groupFileColors.get(key).add(parsed.color);
      // 멀티 팔레트: alias 그룹도 수집
      if (parsed.palettes && parsed.palettes.length > 1) {
        for (const p of parsed.palettes.slice(1)) {
          const pKey = `${p.material}.${p.version}`;
          if (!groupFileColors.has(pKey) && !extraGroups.has(pKey)) {
            extraGroups.set(pKey, p.color);
          }
        }
      }
    }
  }

  const result = [];

  if (rawColors.size > 0) {
    const colors = [...rawColors].sort((a, b) => a.localeCompare(b));
    result.push({ material: null, version: null, colors, fileColors: colors });
  }

  if (groupFileColors.size === 0) return result;

  const hasMultiColorGroup = [...groupFileColors.values()].some(s => s.size > 1);
  // 파일 그룹이 1개이거나 멀티 팔레트 통합 파일이면 팔레트 전체 확장 허용
  const canExpand = groupFileColors.size === 1;

  for (const [key, colorSet] of groupFileColors) {
    const dotIdx   = key.indexOf('.');
    const material = key.slice(0, dotIdx);
    const version  = key.slice(dotIdx + 1);
    const paletteColors = palettes?.[material]?.[version];

    let colorsToAdd;
    if (canExpand && paletteColors) {
      colorsToAdd = Object.keys(paletteColors).filter(c => c !== 'source');
    } else if (colorSet.size > 1) {
      colorsToAdd = [...colorSet];
    } else if (!hasMultiColorGroup) {
      colorsToAdd = [...colorSet];
    } else {
      continue;
    }

    result.push({
      material,
      version,
      colors: [...colorsToAdd].sort((a, b) => a.localeCompare(b)),
      fileColors: [...colorSet],
    });
  }

  // 멀티 팔레트 파일에 내포된 추가 팔레트 그룹 (all.lpcr 등)
  for (const [key, baseColor] of extraGroups) {
    const dotIdx   = key.indexOf('.');
    const material = key.slice(0, dotIdx);
    const version  = key.slice(dotIdx + 1);
    const paletteColors = palettes?.[material]?.[version];
    if (!paletteColors) continue;
    result.push({
      material,
      version,
      colors: Object.keys(paletteColors).filter(c => c !== 'source').sort((a, b) => a.localeCompare(b)),
      fileColors: [baseColor],
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
