'use strict';
/**
 * build-index.js — index.json + index.json.gz 생성 (Step 3)
 *
 * spritesheets/ 하위의 모든 프로젝트 폴더를 자동 감지한다.
 *   spritesheets/ULPC/    → ULPC/arms/... 경로 + ULPC/palette.json
 *   spritesheets/monster/ → monster/body/... 경로 + monster/palette.json
 *
 * 출력 index.json:
 *   files    : 모든 프로젝트의 파일 경로 배열 (ULPC/arms/..., monster/body/... 등)
 *   palettes : 모든 프로젝트의 팔레트 병합 (같은 material.version 키는 color 단위로 합산)
 *
 * 실행: node build-index.js
 */
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { OUT_ROOT, OUT_SPRITES } = require('./lib');

// ── 사전 조건 확인 ────────────────────────────────────────────────────────────
if (!fs.existsSync(OUT_SPRITES)) {
  console.error('❌ spritesheets/ 폴더 없음. 먼저 extract-ulpc.js 를 실행하세요.');
  process.exit(1);
}

console.log('=== index.json 생성 ===');

// ── 1. 프로젝트 폴더 자동 감지 ───────────────────────────────────────────────
const projects = fs.readdirSync(OUT_SPRITES, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name);

if (projects.length === 0) {
  console.error('❌ spritesheets/ 안에 프로젝트 폴더가 없습니다.');
  process.exit(1);
}
console.log(`프로젝트 감지: ${projects.join(', ')}\n`);

// ── 2. 팔레트 병합 ────────────────────────────────────────────────────────────
// 구조: { material: { version: { color: [hex, ...] } } }
// 같은 material.version 키가 여러 프로젝트에 있으면 color 단위로 합산 (덮어쓰기 없음)
const palettes = {};

for (const proj of projects) {
  const palPath = path.join(OUT_SPRITES, proj, 'palette.json');
  if (!fs.existsSync(palPath)) {
    console.warn(`  ⚠️  ${proj}/palette.json 없음 — 팔레트 제외`);
    continue;
  }
  const projPalette = JSON.parse(fs.readFileSync(palPath, 'utf8'));
  console.log(`  ${proj}/palette.json 로드`);

  for (const [mat, versions] of Object.entries(projPalette)) {
    if (!palettes[mat]) palettes[mat] = {};
    for (const [ver, colors] of Object.entries(versions)) {
      if (!palettes[mat][ver]) palettes[mat][ver] = {};
      for (const [color, hexArr] of Object.entries(colors)) {
        if (!palettes[mat][ver][color]) {
          // 새 색상 — 그대로 추가
          palettes[mat][ver][color] = hexArr;
        }
        // 이미 존재하면 유지 (프로젝트 추가 순서 우선, 덮어쓰기 안 함)
      }
    }
  }
}

let totalColors = 0;
for (const [mat, vers] of Object.entries(palettes)) {
  for (const [ver, cols] of Object.entries(vers)) {
    const c = Object.keys(cols).length;
    totalColors += c;
    console.log(`  ${mat}.${ver}: ${c}개 색상`);
  }
}
console.log(`팔레트 총 색상 엔트리: ${totalColors}개\n`);

// ── 3. 파일 목록 수집 (모든 프로젝트) ────────────────────────────────────────
console.log('파일 목록 수집 중...');
const files = [];

function walkDir(dir, base) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, base);
    } else if (entry.name.endsWith('.png')) {
      files.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
}
walkDir(OUT_SPRITES, OUT_SPRITES);
files.sort();
console.log(`파일 수: ${files.length}개`);

// ── 4. index.json.gz 저장 ────────────────────────────────────────────────────
const output  = { files, palettes };
const jsonStr = JSON.stringify(output);
const gzPath  = path.join(OUT_SPRITES, 'index.json.gz');

const gzBuffer = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
fs.writeFileSync(gzPath, gzBuffer);
const rawSizeMB = (Buffer.byteLength(jsonStr, 'utf8') / 1024 / 1024).toFixed(2);
const gzSizeMB  = (gzBuffer.length / 1024 / 1024).toFixed(2);
const ratio     = (100 - (gzBuffer.length / Buffer.byteLength(jsonStr, 'utf8') * 100)).toFixed(1);
console.log(`\n✅ index.json.gz 저장 완료: ${gzPath}`);
console.log(`   원본 크기: ${rawSizeMB} MB → 압축 크기: ${gzSizeMB} MB (${ratio}% 절감)`);
