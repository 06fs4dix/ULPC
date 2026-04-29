'use strict';
/**
 * convert.js
 * mapping.json을 기반으로 파일을 spritesheets/ → NEW_ULPC/spritesheets/ 로 복사
 * 실행: node convert.js
 * 옵션: --dry-run  → 실제 복사 없이 예행 출력
 */
const fs   = require('fs');
const path = require('path');
const { SPRITES_DIR, OUT_ROOT, OUT_SPRITES } = require('./lib');

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) console.log('[DRY-RUN 모드: 실제 복사 없음]');

// ── 사전 조건 확인 ─────────────────────────────────────────────────────────────
const mappingPath = path.join(OUT_ROOT, 'mapping.json');
if (!fs.existsSync(mappingPath)) {
  console.error('mapping.json 없음. 먼저 analyze.js를 실행하세요.');
  process.exit(1);
}
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
console.log(`매핑 엔트리: ${mapping.length}개`);
console.log(`대상 폴더: ${OUT_SPRITES}`);

// ── 기존 spritesheets 폴더 초기화 ────────────────────────────────────────────
if (!isDryRun && fs.existsSync(OUT_SPRITES)) {
  console.log('기존 spritesheets 폴더 삭제 중...');
  fs.rmSync(OUT_SPRITES, { recursive: true, force: true });
  console.log('삭제 완료');
}

// ── 중복 대상 경로 사전 계산 ──────────────────────────────────────────────────
// 같은 newPath로 여러 파일이 매핑된 경우 → 두 번째부터 _dup2, _dup3 로 rename
const pathUsed = {}; // newPath → 사용 횟수

// ── 복사 실행 ──────────────────────────────────────────────────────────────────
let copied = 0, duped = 0, errors = 0;
const log = [];

console.log('\n복사 시작...');

for (const entry of mapping) {
  const srcPath = path.join(SPRITES_DIR, entry.oldPath);
  let   dstPath = path.join(OUT_SPRITES, entry.newPath);

  // 중복 처리: 같은 대상이 이미 있으면 _dup{N} 붙이기
  const key = entry.newPath;
  if (pathUsed[key] === undefined) {
    pathUsed[key] = 0;
  } else {
    pathUsed[key]++;
    const ext  = path.extname(dstPath);
    const base = path.basename(dstPath, ext);
    const dir  = path.dirname(dstPath);
    dstPath = path.join(dir, `${base}_dup${pathUsed[key] + 1}${ext}`);
    log.push({ status: 'dup', old: entry.oldPath, intended: entry.newPath, actual: path.relative(OUT_SPRITES, dstPath) });
    duped++;
  }

  if (!isDryRun) {
    try {
      const dstDir = path.dirname(dstPath);
      if (!fs.existsSync(dstDir)) {
        fs.mkdirSync(dstDir, { recursive: true });
      }
      fs.copyFileSync(srcPath, dstPath);
      copied++;
    } catch (e) {
      log.push({ status: 'error', old: entry.oldPath, error: e.message });
      errors++;
    }
  } else {
    copied++;
  }

  if ((copied + duped + errors) % 10000 === 0 && (copied + duped + errors) > 0) {
    process.stdout.write(`  ${copied + duped + errors}개 처리 중...\r`);
  }
}

// ── 결과 출력 ──────────────────────────────────────────────────────────────────
console.log(`\n\n=== ${isDryRun ? '예행(DRY-RUN)' : '복사'} 완료 ===`);
console.log(`복사:   ${copied}개`);
console.log(`중복:   ${duped}개`);
console.log(`오류:   ${errors}개`);

if (log.length > 0) {
  fs.writeFileSync(
    path.join(OUT_ROOT, 'convert-log.json'),
    JSON.stringify(log, null, 2),
    'utf8'
  );
  console.log('convert-log.json 저장 완료');
}

// ── 파일 인덱스 JSON 생성 ─────────────────────────────────────────────────────
if (!isDryRun) {
  console.log('\n파일 인덱스 생성 중...');
  const index = [];

  function walkForIndex(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkForIndex(full, base);
      } else if (entry.name.endsWith('.png')) {
        index.push(path.relative(base, full).replace(/\\/g, '/'));
      }
    }
  }

  if (fs.existsSync(OUT_SPRITES)) {
    walkForIndex(OUT_SPRITES, OUT_SPRITES);
    index.sort();

    const indexPath = path.join(OUT_ROOT, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    console.log(`index.json 저장 완료 (${index.length}개)`);
  }
}
