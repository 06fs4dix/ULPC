/**
 * state.js — 전역 상태 + 변경 콜백
 */

export const state = {
  // 데이터
  tree:     null,
  itemMap:  null,
  palettes: null,
  files:    null,

  // 프로젝트
  selectedProject: 'ULPC',
  pathPrefix:  '',              // e.g. 'ULPC/' — index.json 경로에서 제거할 접두어
  imageBase:   '../spritesheets/', // 이미지 URL 기반 경로

  // 선택 상태
  selections: {},       // prefix → { colors: { "material.version": colorName } }
  expandedNodes: {},    // path → boolean

  // 필터
  searchQuery: '',

  // 크레딧
  credits: null,   // credits.json { Authors, Licenses, URLs }

  // 애니메이션
  selectedAnimation: 'walk',
  selectedDirection: 2, // 0=up,1=left,2=down,3=right
  currentFrame:      0,
  fps:               10,
  isAnimating:       false,

  // 줌
  zoomLevel: 3,

  // 사전 베이크된 캐릭터 합성 시트
  characterSheet: null,   // HTMLCanvasElement — buildCharacterSheet() 결과
  animLayout: {},         // animName → { startY, maxFrameSize, dirCount, frameCount }
};

// 선택/상태 변경 시 호출되는 콜백 목록
const changeListeners = [];

export function onSelectionChange() {
  for (const cb of changeListeners) cb();
}

export function addChangeListener(cb) {
  changeListeners.push(cb);
}
