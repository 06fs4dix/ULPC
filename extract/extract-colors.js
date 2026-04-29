'use strict';
/**
 * extract-colors.js
 * item-metadata.js의 paletteMetadata에서 두 가지를 추출한다.
 *   1. colors.json  — 컬러 이름 목록 (analyze.js가 파일명 판별에 사용)
 *   2. palette.json — material/version/color → hex[] 전체 팔레트 테이블
 *                     (build-index.js가 index.json 생성 시 포함)
 *
 * 실행: node extract-colors.js
 */
const fs   = require('fs');
const path = require('path');
const { META_FILE, OUT_ROOT } = require('./lib');

console.log('=== 컬러 / 팔레트 추출 ===');
console.log(`소스: ${META_FILE}`);

const content = fs.readFileSync(META_FILE, 'utf8');

// ── paletteMetadata 섹션 추출 ─────────────────────────────────────────────────
const palStart = content.indexOf('const paletteMetadata');
if (palStart === -1) {
  console.error('paletteMetadata를 찾을 수 없습니다.');
  process.exit(1);
}
const palEnd     = content.indexOf('\nexport ', palStart);
const palSection = palEnd > palStart ? content.slice(palStart, palEnd) : content.slice(palStart);

// ── 1. colors.json: 컬러 이름 목록 ──────────────────────────────────────────
// 패턴: "colorname": ["#rrggbb", ...] — 헥스 배열의 키만 컬러로 간주
const colorSet   = new Set();
const hexArrayRe = /"([a-z][a-z0-9_]*)"\s*:\s*\[\s*"#[0-9a-fA-F]{6}"/g;
let m;
while ((m = hexArrayRe.exec(palSection)) !== null) {
  colorSet.add(m[1]);
}
console.log(`컬러 이름 추출: ${colorSet.size}개`);

const colors      = [...colorSet].sort();
const colorsPath  = path.join(OUT_ROOT, 'colors.json');
fs.writeFileSync(colorsPath, JSON.stringify(colors, null, 2), 'utf8');
console.log(`저장: ${colorsPath}`);

// ── 2. palette.json: material/version/color → hex[] ────────────────────────
// 구조: { "metal": { "ulpc": { "steel": ["#..."], ... }, "lpcr": {...} }, ... }
const palettes = {};
const lines    = palSection.split('\n');

let currentMaterial = null;
let currentVersion  = null;
let currentColor    = null;
let inHexArray      = false;

for (const line of lines) {
  // material 진입 (4칸 들여쓰기)
  const matMatch = line.match(/^\s{4}"(all|body|cloth|eye|hair|metal)"\s*:/);
  if (matMatch) {
    currentMaterial = matMatch[1];
    if (!palettes[currentMaterial]) palettes[currentMaterial] = {};
    currentVersion = null;
    currentColor   = null;
    continue;
  }
  if (!currentMaterial) continue;

  // version 진입 (8칸 들여쓰기)
  const verMatch = line.match(/^\s{8}"(lpcr|ulpc)"\s*:\s*\{/);
  if (verMatch) {
    currentVersion = verMatch[1];
    if (!palettes[currentMaterial][currentVersion]) {
      palettes[currentMaterial][currentVersion] = {};
    }
    continue;
  }
  if (!currentVersion) continue;

  // 색상 키 진입 (10칸 들여쓰기)
  const colorMatch = line.match(/^\s{10}"([a-z][a-z0-9_]*)"\s*:\s*\[/);
  if (colorMatch) {
    currentColor = colorMatch[1];
    inHexArray   = true;
    palettes[currentMaterial][currentVersion][currentColor] = [];
    // 같은 줄에 hex가 있는 경우
    const inlineHex = line.match(/#[0-9a-fA-F]{6}/g);
    if (inlineHex) {
      palettes[currentMaterial][currentVersion][currentColor].push(
        ...inlineHex.map(h => h.toLowerCase())
      );
    }
    if (line.includes(']')) inHexArray = false;
    continue;
  }

  // hex 값 추가
  if (inHexArray && currentColor) {
    const hexMatch = line.match(/"(#[0-9a-fA-F]{6})"/);
    if (hexMatch) {
      palettes[currentMaterial][currentVersion][currentColor].push(hexMatch[1].toLowerCase());
    }
    if (line.includes(']')) {
      inHexArray   = false;
      currentColor = null;
    }
  }
}

// 결과 검증 및 저장
let totalColors = 0;
for (const [mat, vers] of Object.entries(palettes)) {
  for (const [ver, cols] of Object.entries(vers)) {
    const count = Object.keys(cols).length;
    totalColors += count;
    console.log(`  ${mat}.${ver}: ${count}개 색상`);
  }
}
console.log(`팔레트 총 색상 엔트리: ${totalColors}개`);

const palettePath = path.join(OUT_ROOT, 'palette.json');
fs.writeFileSync(palettePath, JSON.stringify(palettes, null, 2), 'utf8');
console.log(`저장: ${palettePath}`);
