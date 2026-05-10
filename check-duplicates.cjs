/**
 * ULPC 스프라이트시트 중복 이미지 검사 스크립트
 * 사용법: node check-duplicates.cjs [옵션]
 *
 * 옵션:
 *   --dir <경로>       검사할 폴더 (기본값: ./spritesheets)
 *   --out <파일>       결과를 JSON 파일로 저장
 *   --verbose          중복 그룹 상세 출력
 *   --pattern <패턴>   특정 패턴만 출력
 *                      (dup_suffix / male_thin / lizard_variant / default_white / same_dir_diff_name / other)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 인자 파싱 ─────────────────────────────────────────────
const args = process.argv.slice(2);
let targetDir    = path.join(__dirname, 'spritesheets');
let outFile      = null;
let verbose      = false;
let filterPattern = null;

for (let i = 0; i < args.length; i++) {
  if      (args[i] === '--dir'     && args[i + 1]) targetDir     = args[++i];
  else if (args[i] === '--out'     && args[i + 1]) outFile       = args[++i];
  else if (args[i] === '--verbose')                verbose       = true;
  else if (args[i] === '--pattern' && args[i + 1]) filterPattern = args[++i];
  else if (!args[i].startsWith('--'))              targetDir     = args[i];
}

targetDir = path.resolve(targetDir);

// ── 유틸 ──────────────────────────────────────────────────
function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

function walkDir(dir, exts, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory())                                        walkDir(full, exts, results);
    else if (exts.includes(path.extname(e.name).toLowerCase())) results.push(full);
  }
  return results;
}

function fmtSize(bytes) {
  if (bytes < 1024)      return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

// ── 중복 패턴 분류 ────────────────────────────────────────
function classifyGroup(files) {
  const names = files.map(f => path.basename(f));
  const dirs  = files.map(f => path.dirname(f));

  // 1) _dup2, _dup3 등 추출 시 생긴 중복 파일
  if (names.some(n => /_dup\d+/.test(n))) return 'dup_suffix';

  // 2) p[male] ↔ p[thin] 경로 차이
  const hasMale = dirs.some(d => d.includes('p[male]'));
  const hasThin = dirs.some(d => d.includes('p[thin]'));
  if (hasMale && hasThin) return 'male_thin';

  // 3) p[lizard] 서브경로 차이
  const hasLizard = dirs.some(d => d.includes('p[lizard]'));
  const noLizard  = dirs.some(d => !d.includes('p[lizard]'));
  if (hasLizard && noLizard) return 'lizard_variant';

  // 4) default = white (색상명만 다르고 픽셀 동일)
  const hasDefault = names.some(n => n.startsWith('default'));
  const hasWhite   = names.some(n => /^white[_.]/.test(n) || n.includes('.white.') || n.includes('_white_'));
  if (hasDefault && hasWhite) return 'default_white';

  // 5) 동일 폴더 내 다른 이름
  if (new Set(dirs).size === 1) return 'same_dir_diff_name';

  return 'other';
}

const PATTERN_LABELS = {
  dup_suffix:         '추출 버그 (_dup2 등)',
  male_thin:          'p[male] ↔ p[thin] 구조 중복',
  lizard_variant:     'lizard 서브경로 중복',
  default_white:      'default = white 색상 중복',
  same_dir_diff_name: '같은 폴더 다른 이름',
  other:              '기타',
};

// ── 메인 ──────────────────────────────────────────────────
console.log(`\n검사 대상: ${targetDir}`);
console.log('파일 목록 수집 중...');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const files = walkDir(targetDir, IMAGE_EXTS);
console.log(`총 ${files.length.toLocaleString()}개 이미지 발견\n`);

if (files.length === 0) { console.log('이미지 파일이 없습니다.'); process.exit(0); }

// 해시 계산
const hashMap = new Map();
let processed = 0;
const startTime = Date.now();

for (const f of files) {
  const hash = hashFile(f);
  if (!hashMap.has(hash)) hashMap.set(hash, []);
  hashMap.get(hash).push(f);
  processed++;
  if (processed % 1000 === 0) {
    const pct = ((processed / files.length) * 100).toFixed(1);
    process.stdout.write(`\r진행: ${processed.toLocaleString()} / ${files.length.toLocaleString()} (${pct}%)`);
  }
}
process.stdout.write('\r' + ' '.repeat(60) + '\r');
console.log(`해시 계산 완료 (${((Date.now() - startTime) / 1000).toFixed(1)}초)\n`);

// 중복 그룹 추출 + 분류
const dupGroups = [];
let totalDupFiles = 0, totalDupSize = 0;

for (const [hash, paths] of hashMap) {
  if (paths.length < 2) continue;
  const size    = fs.statSync(paths[0]).size;
  const pattern = classifyGroup(paths);
  dupGroups.push({ hash, size, files: paths, pattern });
  totalDupFiles += paths.length - 1;
  totalDupSize  += size * (paths.length - 1);
}

dupGroups.sort((a, b) => b.size * b.files.length - a.size * a.files.length);

// 패턴별 집계
const patternStats = {};
for (const g of dupGroups) {
  if (!patternStats[g.pattern]) patternStats[g.pattern] = { groups: 0, files: 0, bytes: 0 };
  patternStats[g.pattern].groups++;
  patternStats[g.pattern].files += g.files.length - 1;
  patternStats[g.pattern].bytes += g.size * (g.files.length - 1);
}

// ── 결과 출력 ─────────────────────────────────────────────
console.log('══════════════════════════════════════════════════');
console.log(`중복 그룹: ${dupGroups.length.toLocaleString()}개`);
console.log(`중복 파일: ${totalDupFiles.toLocaleString()}개 (삭제 가능)`);
console.log(`절약 가능 용량: ${fmtSize(totalDupSize)}`);
console.log('──────────────────────────────────────────────────');
console.log('패턴별 분류:');
for (const [pat, s] of Object.entries(patternStats).sort((a, b) => b[1].files - a[1].files)) {
  const label = PATTERN_LABELS[pat] || pat;
  console.log(`  [${label}]  그룹 ${s.groups}개 / 삭제가능 ${s.files}개 / ${fmtSize(s.bytes)}`);
}
console.log('══════════════════════════════════════════════════\n');

if (filterPattern) console.log(`필터: --pattern ${filterPattern}\n`);

const displayGroups = filterPattern ? dupGroups.filter(g => g.pattern === filterPattern) : dupGroups;
const limit = verbose ? displayGroups.length : Math.min(displayGroups.length, 20);

for (let i = 0; i < limit; i++) {
  const g = displayGroups[i];
  console.log(`[그룹 ${i + 1}] [${PATTERN_LABELS[g.pattern] || g.pattern}]  MD5: ${g.hash}  크기: ${fmtSize(g.size)}  파일수: ${g.files.length}`);
  for (const f of g.files) console.log(`  ${f}`);
  console.log();
}
if (!verbose && displayGroups.length > 20) {
  console.log(`... 외 ${displayGroups.length - 20}개 그룹 (--verbose 옵션으로 전체 출력)\n`);
}

// ── JSON 저장 ─────────────────────────────────────────────
const report = {
  scannedDir: targetDir,
  scannedAt: new Date().toISOString(),
  totalFiles: files.length,
  duplicateGroups: dupGroups.length,
  duplicateFiles: totalDupFiles,
  savableBytes: totalDupSize,
  savableSize: fmtSize(totalDupSize),
  patternStats,
  groups: dupGroups.map(g => ({
    hash: g.hash, size: g.size, count: g.files.length,
    pattern: g.pattern, files: g.files,
  })),
};

const saveTarget = outFile || path.join(__dirname, 'duplicate-report.json');
fs.writeFileSync(saveTarget, JSON.stringify(report, null, 2), 'utf8');
console.log(`결과 저장: ${saveTarget}`);
