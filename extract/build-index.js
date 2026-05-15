'use strict';
/**
 * build-index.js — spritesheets/ 하위 각 프로젝트 폴더의 index.json 생성
 *
 * 각 프로젝트 폴더를 순회해 PNG 목록을 수집하고 (icon.png 제외),
 * palette.json 이 있으면 포함해 index.json 을 생성한다.
 *
 * 실행:
 *   node build-index.js           # 전체 프로젝트
 *   node build-index.js ULPC      # 특정 프로젝트만
 */

const fs   = require('fs');
const path = require('path');

const SPRITES_ROOT = path.join(__dirname, '../spritesheets');

if (!fs.existsSync(SPRITES_ROOT)) {
  console.error(`❌ 폴더 없음: ${SPRITES_ROOT}`);
  process.exit(1);
}

const targetProject = process.argv[2] || null;

const projectDirs = fs.readdirSync(SPRITES_ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && (!targetProject || e.name === targetProject))
  .map(e => e.name);

if (projectDirs.length === 0) {
  console.error(targetProject
    ? `❌ 프로젝트 폴더 없음: spritesheets/${targetProject}`
    : '❌ spritesheets/ 에 프로젝트 폴더가 없습니다.');
  process.exit(1);
}

for (const project of projectDirs) {
  const projectDir = path.join(SPRITES_ROOT, project);
  console.log(`\n=== index.json 생성: ${project} ===`);

  // PNG 목록 수집 (icon.png 제외)
  const files = [];
  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (entry.name.endsWith('.png') && entry.name !== 'icon.png') {
        files.push(path.relative(projectDir, full).replace(/\\/g, '/'));
      }
    }
  }
  walkDir(projectDir);
  files.sort();
  console.log(`  파일 수: ${files.length}개`);

  // palette.json 로드
  const palPath = path.join(projectDir, 'palette.json');
  const palettes = fs.existsSync(palPath)
    ? JSON.parse(fs.readFileSync(palPath, 'utf8'))
    : {};
  if (Object.keys(palettes).length > 0) {
    const matCount = Object.keys(palettes).length;
    console.log(`  팔레트 로드: ${matCount}개 material`);
  }

  const jsonPath = path.join(projectDir, 'index.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ files, palettes }), 'utf8');

  const sizeKB = (fs.statSync(jsonPath).size / 1024).toFixed(1);
  console.log(`  ✅ index.json 저장: ${sizeKB} KB`);
}

console.log('\n완료.');
