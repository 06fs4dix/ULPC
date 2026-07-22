'use strict';
/**
 * split-sit-plop.js
 *
 * ULPC a[sit] 3프레임 시트를 분리한다.
 *   F0      → a[sit]  1프레임  (*_N_1_dirs.png)
 *   F1..F2  → a[plop] 2프레임  (*_N_2_dirs.png)
 *
 * 실행:
 *   node split-sit-plop.js           # 실제 변환
 *   node split-sit-plop.js --dry-run # 분석만
 *   node split-sit-plop.js ULPC
 */
const fs   = require('fs');
const path = require('path');
const PNG  = require('pngjs').PNG;

const SPRITES_ROOT = path.join(__dirname, '../spritesheets');
const isDryRun = process.argv.includes('--dry-run');
const targetProject = process.argv.slice(2).find(a => a !== '--dry-run') || 'ULPC';

/** loader.js 와 동일한 우측 토큰 파싱 */
function parseFilename(fname) {
  const base = fname.replace(/\.png$/i, '');
  const t = base.split('_');
  if (t.length < 3) return null;

  const last = t[t.length - 1];
  const prev = t[t.length - 2];
  const prev2 = t[t.length - 3];

  let frameCount, frameSize, dirs, restTokens;
  if (/^\d+$/.test(prev2) && /^\d+$/.test(prev) && /^[0-3]+$/.test(last)) {
    dirs = last;
    frameCount = parseInt(prev, 10);
    frameSize = parseInt(prev2, 10);
    restTokens = t.slice(0, -3);
  } else if (/^\d+$/.test(prev) && /^\d+$/.test(last)) {
    dirs = null;
    frameCount = parseInt(last, 10);
    frameSize = parseInt(prev, 10);
    restTokens = t.slice(0, -2);
  } else {
    return null;
  }
  if (!Number.isFinite(frameSize) || !Number.isFinite(frameCount) || frameSize < 1) return null;
  return { color: restTokens.join('_') || 'default', frameSize, frameCount, dirs };
}

function cropColumns(src, frameSize, startCol, colCount) {
  const srcCols = Math.floor(src.width / frameSize);
  const dst = new PNG({ width: colCount * frameSize, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let c = 0; c < colCount; c++) {
      const srcCol = startCol + c;
      if (srcCol >= srcCols) continue;
      for (let px = 0; px < frameSize; px++) {
        const si = (y * src.width + srcCol * frameSize + px) * 4;
        const di = (y * dst.width + c * frameSize + px) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }
  return dst;
}

function writePng(dstPath, png) {
  const dir = path.dirname(dstPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dstPath, PNG.sync.write(png));
}

function walkSitDirs(projectDir, acc = []) {
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'a[sit]') acc.push(full);
        else walk(full);
      }
    }
  }
  walk(projectDir);
  return acc;
}

function processSitFile(filePath, sitDir) {
  const fname = path.basename(filePath);
  if (!fname.endsWith('.png') || fname === 'icon.png') {
    return { status: 'skip', reason: 'not_sheet' };
  }

  // convert 중복 산출물: white_64_3_0213_dup2.png → 메타는 dup 제거 후 파싱
  const parseName = fname.replace(/_dup\d+(?=\.png$)/i, '');
  const parsed = parseFilename(parseName);
  if (!parsed) return { status: 'error', reason: 'parse_fail', fname };

  const { frameSize, frameCount, dirs, color } = parsed;
  const src = PNG.sync.read(fs.readFileSync(filePath));
  const srcCols = Math.floor(src.width / frameSize);
  const srcRows = Math.floor(src.height / frameSize);

  // 이미 1프레임 sit 이면 스킵 (재실행 안전)
  if (frameCount === 1 && srcCols === 1) {
    return { status: 'skip', reason: 'already_sit1', fname };
  }

  if (srcCols < 3) {
    return { status: 'error', reason: `cols<3 (${srcCols})`, fname, dim: `${src.width}x${src.height}` };
  }

  // 부모: .../p[item]/a[sit]/zN  → plop: .../p[item]/a[plop]/zN
  const zName = path.basename(sitDir);           // z70
  const itemDir = path.dirname(sitDir);          // .../a[sit] 의 부모? wait sitDir IS a[sit]
  // sitDir = .../a[sit]
  // files are in .../a[sit]/zN/file.png  OR sometimes directly under a[sit]?
  // Structure: a[sit]/zN/file.png  so filePath parent is zN, sitDir is a[sit]
  // Actually walk collects a[sit] dirs; files live in z* children.

  const parentOfSit = path.dirname(sitDir); // item prefix folder
  const relFromSit = path.relative(sitDir, filePath); // e.g. z70/name.png
  const plopBase = path.join(parentOfSit, 'a[plop]');
  const plopPath = path.join(plopBase, relFromSit);
  const sitOutPath = filePath; // overwrite location after rename

  const dirSuffix = dirs != null ? `_${dirs}` : '';
  const sitName  = `${color}_${frameSize}_1${dirSuffix}.png`;
  const plopName = `${color}_${frameSize}_2${dirSuffix}.png`;

  const sitOut  = path.join(path.dirname(filePath), sitName);
  const plopOut = path.join(path.dirname(plopPath), plopName);

  if (isDryRun) {
    return {
      status: 'ok',
      dry: true,
      fname,
      sitName,
      plopName,
      dim: `${src.width}x${src.height}`,
      cols: srcCols,
      rows: srcRows,
    };
  }

  const sitPng  = cropColumns(src, frameSize, 0, 1);
  const plopPng = cropColumns(src, frameSize, 1, 2);
  src.data = null;

  writePng(sitOut, sitPng);
  sitPng.data = null;
  writePng(plopOut, plopPng);
  plopPng.data = null;

  // 원본 3프레임 파일이 새 이름과 다르면 삭제
  if (path.resolve(filePath) !== path.resolve(sitOut)) {
    fs.unlinkSync(filePath);
  }

  return { status: 'ok', fname, sitName, plopName, sitOut, plopOut };
}

function processProject(project) {
  const projectDir = path.join(SPRITES_ROOT, project);
  if (!fs.existsSync(projectDir)) {
    console.error('missing project', projectDir);
    process.exit(1);
  }

  console.log(`\n=== split sit→sit+plop: ${project}${isDryRun ? ' (dry-run)' : ''} ===`);
  const sitDirs = walkSitDirs(projectDir);
  console.log(`a[sit] folders: ${sitDirs.length}`);

  let ok = 0, skip = 0, err = 0;
  const errors = [];

  for (const sitDir of sitDirs) {
    // collect png under a[sit] recursively (z* folders)
    const stack = [sitDir];
    const files = [];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith('.png')) files.push(full);
      }
    }

    for (const f of files) {
      // only process files that are under a[sit] tree (already)
      try {
        const r = processSitFile(f, sitDir);
        if (r.status === 'ok') {
          ok++;
          if (ok <= 8 || (ok % 1000 === 0)) {
            console.log(`  [${ok}] ${r.fname} → sit:${r.sitName} + plop:${r.plopName}`);
          }
        } else if (r.status === 'skip') {
          skip++;
        } else {
          err++;
          errors.push(r);
          if (errors.length <= 20) console.warn('  !', r.fname, r.reason, r.dim || '');
        }
      } catch (e) {
        err++;
        errors.push({ fname: path.basename(f), reason: e.message });
        if (errors.length <= 20) console.warn('  !', path.basename(f), e.message);
      }
    }
  }

  console.log(`\n  ok: ${ok}`);
  console.log(`  skip: ${skip}`);
  console.log(`  error: ${err}`);
  if (errors.length > 20) console.log(`  (first 20 errors shown, total ${errors.length})`);
  return { ok, skip, err, errors };
}

const result = processProject(targetProject);
console.log('\n완료.' + (isDryRun ? ' dry-run — 파일 미변경. 본실행: node split-sit-plop.js' : ' 다음: node build-index.js ULPC'));
if (result.err > 0) process.exitCode = 1;
