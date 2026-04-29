'use strict';
/**
 * verify.js
 * 원본 spritesheets/ vs NEW_ULPC/spritesheets/ 파일 수·경로 일치 여부 검증
 * 실행: node verify.js
 */
const fs   = require('fs');
const path = require('path');
const { SPRITES_DIR, OUT_ROOT, OUT_SPRITES } = require('./lib');

function countPNGs(dir, skipLpctools = false) {
  let count = 0;
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (skipLpctools && entry.name === 'lpctools') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.png')) count++;
    }
  }
  walk(dir);
  return count;
}

console.log('=== 검증 ===\n');

// ── 파일 수 비교 ──────────────────────────────────────────────────────────────
const oldCount = countPNGs(SPRITES_DIR, true); // lpctools 제외
const newCount = countPNGs(OUT_SPRITES);

console.log(`원본 파일 수 (lpctools 제외): ${oldCount}`);
console.log(`새 파일 수:                   ${newCount}`);
console.log(`차이:                         ${oldCount - newCount}`);

// ── mapping.json 교차 검증 ────────────────────────────────────────────────────
const mappingPath = path.join(OUT_ROOT, 'mapping.json');
if (!fs.existsSync(mappingPath)) {
  console.log('\nmapping.json 없음 - 교차 검증 생략');
} else {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  console.log(`\n매핑 엔트리: ${mapping.length}개`);

  let missing = 0, missingList = [];
  for (const entry of mapping) {
    const dstPath = path.join(OUT_SPRITES, entry.newPath);
    if (!fs.existsSync(dstPath)) {
      missing++;
      if (missingList.length < 20) missingList.push(entry.newPath);
    }
  }
  console.log(`누락 파일: ${missing}개`);
  if (missingList.length > 0) {
    console.log('  (첫 20개 예시)');
    missingList.forEach(p => console.log(`  - ${p}`));
  }
}

// ── 판정 ─────────────────────────────────────────────────────────────────────
console.log('');
if (oldCount === newCount) {
  console.log('✓ 파일 수 일치 - 변환 성공');
} else {
  console.log('⚠ 파일 수 불일치');
  if (oldCount > newCount) {
    console.log(`  → ${oldCount - newCount}개 파일이 새 폴더에 없음 (중복 경로 병합 또는 오류)`);
  } else {
    console.log(`  → 새 폴더에 원본보다 ${newCount - oldCount}개 더 많음 (dup 파일 포함 가능)`);
  }
}
