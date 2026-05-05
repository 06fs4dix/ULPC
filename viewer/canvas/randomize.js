/**
 * randomize.js — 랜덤 캐릭터 생성
 *
 * 각 프로젝트별 export 함수를 제공한다.
 * 반환값은 state.selections와 동일한 포맷:
 *   { [prefix]: { colors: { "material.version": colorName } } }
 *
 * prefix 형식: itemMap 키와 동일 (프로젝트 접두어 제외, a[ 이전 경로)
 * 예: "body/p[male]/p[adult]", "head/p[eyes]/p[human]/p[adult]"
 */

import { getAvailableColors, BODY_TYPES } from '../data/loader.js';

// ── 공통 유틸 ─────────────────────────────────────────────────────────────────

/** 배열에서 랜덤 1개 선택 (빈 배열이면 null) */
function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 확률 p(0~1)로 true 반환 */
function chance(p) {
  return Math.random() < p;
}

const BODY_TYPE_SET = new Set(BODY_TYPES);
const AGE_TYPES     = new Set(['adult', 'child', 'teen']);
const GENDER_TYPES  = new Set(['male', 'female']);

/**
 * prefix의 모든 p[...] 세그먼트를 body type / other param 으로 분류
 *
 * 예: "head/p[heads]/p[human]/p[adult]"
 *   → bodyTypes: ['adult'], otherParams: ['heads', 'human']
 */
function classifyParams(prefix) {
  const bodyTypes  = [];
  const otherParams = [];
  for (const seg of prefix.split('/')) {
    if (seg.startsWith('p[') && seg.endsWith(']')) {
      const val = seg.slice(2, -1);
      if (BODY_TYPE_SET.has(val)) bodyTypes.push(val);
      else                        otherParams.push(val);
    }
  }
  return { bodyTypes, otherParams };
}

/**
 * 슬롯키 이후 세그먼트에서 종족(species) 추출
 * body type 키워드가 아닌 첫 번째 p[...] 값을 종족으로 간주
 *
 * 예: prefix="head/p[heads]/p[human]/p[adult]", slotKey="head/p[heads]"
 *   → slotKey 이후: ["p[human]", "p[adult]"]
 *   → bodyType 제외 → "human"
 */
function getSpeciesAfterSlot(prefix, slotKey) {
  const slotDepth  = slotKey.split('/').length;
  const afterSegs  = prefix.split('/').slice(slotDepth);
  for (const seg of afterSegs) {
    if (seg.startsWith('p[') && seg.endsWith(']')) {
      const val = seg.slice(2, -1);
      if (!BODY_TYPE_SET.has(val)) return val;
    }
  }
  return null;
}

/**
 * prefix가 body config와 호환되는지 확인
 *
 * config: { gender?: 'male'|'female', age?: 'adult'|'child'|'teen'|null }
 *
 * 규칙:
 *   - p[universal] 포함 → 항상 통과
 *   - body type 키워드 없음 → 항상 통과
 *   - 반대 성별 포함 → 탈락
 *   - config.age 지정 시 다른 나이 포함 → 탈락
 */
function prefixMatchesConfig(prefix, config) {
  const { bodyTypes } = classifyParams(prefix);

  if (bodyTypes.includes('universal')) return true;
  if (bodyTypes.length === 0)           return true;

  // 성별 체크
  if (config.gender) {
    const opposite = config.gender === 'male' ? 'female' : 'male';
    if (bodyTypes.includes(opposite)) return false;
  }

  // 나이 체크 (config.age가 있고, prefix에 나이 키워드가 있을 때만)
  if (config.age) {
    const prefixAge = bodyTypes.find(bt => AGE_TYPES.has(bt));
    if (prefixAge && prefixAge !== config.age) return false;
  }

  return true;
}

/**
 * prefix의 슬롯 키 반환
 * head: 2레벨  ("head/p[eyes]", "head/p[heads]", ...)
 * 나머지: 1레벨 ("body", "arms", "hair", ...)
 */
function getSlotKey(prefix) {
  const segs = prefix.split('/');
  if (segs[0] === 'head' && segs.length >= 2) {
    return segs[0] + '/' + segs[1];
  }
  return segs[0];
}

/**
 * prefix 목록을 슬롯 키로 그룹화
 * 반환: { [slotKey]: string[] }
 */
function groupBySlot(prefixes) {
  const groups = {};
  for (const prefix of prefixes) {
    const key = getSlotKey(prefix);
    if (!groups[key]) groups[key] = [];
    groups[key].push(prefix);
  }
  return groups;
}

/**
 * prefix에서 랜덤 색상 선택
 *
 * getAvailableColors()가 반환하는 그룹별로 색상 랜덤 선택:
 *   - material === null (default 파일) → 색상 선택 없음
 *   - 팔레트 확장 가능(single material) → 팔레트 전체에서 랜덤
 *   - 파일 색상만 있는 경우 → fileColors에서 랜덤
 *
 * 반환: { "material.version": colorName }
 */
function pickColors(prefix, itemMap, palettes) {
  const groups = getAvailableColors(prefix, itemMap, palettes);
  const colors = {};
  for (const { material, version, colors: colorList } of groups) {
    if (!material) continue; // default — 색상 선택 불필요
    const matKey = `${material}.${version}`;
    const picked = pickRandom(colorList);
    if (picked) colors[matKey] = picked;
  }
  return colors;
}

// ── ULPC 랜덤화 ──────────────────────────────────────────────────────────────

/**
 * ULPC 슬롯 정의
 *
 * required: 무조건 포함 (후보가 없으면 skip)
 * optional: 확률(0~1) 기반 포함
 */
const ULPC_SLOTS = {
  required: [
    'body',
    'head/p[heads]',
    'head/p[eyes]',
  ],
  optional: {
    'hair':              0.75,
    'head/p[faces]':     0.60,
    'feet':              0.70,
    'legs':              0.55,
    'torso':             0.55,
    'arms':              0.50,
    'head/p[ears]':      0.50,
    'head/p[nose]':      0.40,
    'weapons':           0.40,
    'headwear':          0.30,
    'head/p[neck]':      0.30,
    'tools':             0.20,
    'head/p[fins]':      0.15,
    'head/p[horns]':     0.15,
    'head/p[wrinkles]':  0.10,
  },
};

/**
 * ULPC 랜덤 캐릭터 생성
 *
 * @param {Object} itemMap  - state.itemMap  (prefix → 파일경로[])
 * @param {Object} palettes - state.palettes (material → version → color → hex[])
 * @returns {Object} selections - state.selections 포맷
 */
export function randomizeULPC(itemMap, palettes) {
  const allPrefixes = Object.keys(itemMap);
  if (allPrefixes.length === 0) return {};

  // ── Step 1: 슬롯 그룹화 ─────────────────────────────────────────────────────
  const slotGroups = groupBySlot(allPrefixes);

  // ── Step 2: 성별 결정 ────────────────────────────────────────────────────────
  // body 슬롯에서 실제 존재하는 성별 목록 수집
  const availableGenders = [];
  for (const prefix of (slotGroups['body'] || [])) {
    const { bodyTypes } = classifyParams(prefix);
    for (const bt of bodyTypes) {
      if (GENDER_TYPES.has(bt) && !availableGenders.includes(bt)) {
        availableGenders.push(bt);
      }
    }
  }
  const gender = pickRandom(availableGenders.length ? availableGenders : ['male', 'female']);

  // ── Step 3: body prefix 먼저 선택 → 나이 추출 ──────────────────────────────
  // 나이를 독립적으로 뽑으면 body와 다른 파츠 간 나이 불일치 발생 가능
  // body prefix에서 실제 나이를 읽어 config를 확정한다
  const bodyCandidates = (slotGroups['body'] || [])
    .filter(p => prefixMatchesConfig(p, { gender, age: null }));

  const bodyPicked = pickRandom(bodyCandidates);

  let age = null;
  if (bodyPicked) {
    const { bodyTypes } = classifyParams(bodyPicked);
    age = bodyTypes.find(bt => AGE_TYPES.has(bt)) ?? null;
  }

  const config = { gender, age };

  // ── Step 4: 종족(species) 결정 ──────────────────────────────────────────────
  // head/p[heads] 슬롯에서 config 필터 후 존재하는 종족 목록 수집
  const headBaseSlot = 'head/p[heads]';
  const availableSpecies = new Set();

  for (const prefix of (slotGroups[headBaseSlot] || []).filter(p => prefixMatchesConfig(p, config))) {
    const sp = getSpeciesAfterSlot(prefix, headBaseSlot);
    if (sp) availableSpecies.add(sp);
  }
  const species = availableSpecies.size > 0 ? pickRandom([...availableSpecies]) : null;

  // ── Step 5: 슬롯별 랜덤 선택 ────────────────────────────────────────────────
  const selections = {};

  // body는 이미 선택됨 — 색상만 추가
  if (bodyPicked) {
    selections[bodyPicked] = { colors: pickColors(bodyPicked, itemMap, palettes) };
  }

  const allSlotKeys = new Set([
    ...ULPC_SLOTS.required.filter(s => s !== 'body'),
    ...Object.keys(ULPC_SLOTS.optional),
  ]);

  for (const slotKey of allSlotKeys) {
    const isRequired  = ULPC_SLOTS.required.includes(slotKey);
    const probability = ULPC_SLOTS.optional[slotKey] ?? 1;

    // 옵셔널 슬롯: 확률 체크
    if (!isRequired && !chance(probability)) continue;

    // 후보 필터링: body config 기반
    let candidates = (slotGroups[slotKey] || [])
      .filter(p => prefixMatchesConfig(p, config));

    // head 서브슬롯: 종족 필터 추가
    if (slotKey.startsWith('head/') && species) {
      const speciesFiltered = candidates.filter(p => {
        const sp = getSpeciesAfterSlot(p, slotKey);
        // 종족 파라미터가 없거나 일치하면 통과 (관대한 처리)
        return sp === null || sp === species;
      });
      if (speciesFiltered.length > 0) candidates = speciesFiltered;
    }

    if (candidates.length === 0) continue;

    const picked = pickRandom(candidates);
    if (!picked) continue;

    selections[picked] = { colors: pickColors(picked, itemMap, palettes) };
  }

  return selections;
}

// ── NinjaAdventure 랜덤화 ────────────────────────────────────────────────────

/**
 * NinjaAdventure 랜덤 캐릭터 생성
 *
 * NinjaAdventure는 단일 스프라이트(동물/크리처) 선택 방식.
 * 모든 prefix 중 랜덤 1개를 선택한다.
 *
 * TODO: NinjaAdventure 구조 상세 분석 후 슬롯 분리 구현
 *
 * @param {Object} itemMap  - state.itemMap
 * @param {Object} palettes - state.palettes
 * @returns {Object} selections
 */
export function randomizeNinjaAdventure(itemMap, palettes) {
  const allPrefixes = Object.keys(itemMap);
  if (allPrefixes.length === 0) return {};

  const picked = pickRandom(allPrefixes);
  const colors = pickColors(picked, itemMap, palettes);
  return { [picked]: { colors } };
}
