'use strict';
/**
 * resplit-sit-poses.js
 *
 * 잘못 나뉜 a[sit](F0, 1프레임) + a[plop](F1-F2, 2프레임) 을
 * 포즈 3개 × 각 1프레임으로 재분리한다.
 *
 *   F0 → a[sit]         의자에 앉기
 *   F1 → a[sit_lounge]  다리 한쪽 올린 앉기 (구 plop)
 *   F2 → a[sit_lady]    여자처럼 앉기
 *
 * 실행:
 *   node resplit-sit-poses.js
 *   node resplit-sit-poses.js --dry-run
 */
const fs   = require('fs');
const path = require('path');
const PNG  = require('pngjs').PNG;

const PROJECT = path.join(__dirname, '../spritesheets/ULPC');
const isDryRun = process.argv.includes('--dry-run');

const POSES = [
  { key: 'sit',        folder: 'a[sit]',        src: 'F0' },
  { key: 'sit_lounge', folder: 'a[sit_lounge]', src: 'F1' },
  { key: 'sit_lady',   folder: 'a[sit_lady]',   src: 'F2' },
];

function parseFilename(fname) {
  const base = fname.replace(/\.png$/i, '').replace(/_dup\d+$/i, '');
  const t = base.split('_');
  if (t.length < 3) return null;
  const last = t[t.length - 1];
  const prev = t[t.length - 2];
  const prev2 = t[t.length - 3];
  if (/^\d+$/.test(prev2) && /^\d+$/.test(prev) && /^[0-3]+$/.test(last)) {
    return {
      color: t.slice(0, -3).join('_') || 'default',
      frameSize: parseInt(prev2, 10),
      frameCount: parseInt(prev, 10),
      dirs: last,
    };
  }
  if (/^\d+$/.test(prev) && /^\d+$/.test(last)) {
    return {
      color: t.slice(0, -2).join('_') || 'default',
      frameSize: parseInt(prev, 10),
      frameCount: parseInt(last, 10),
      dirs: null,
    };
  }
  return null;
}

function cropCol(src, frameSize, col) {
  const dst = new PNG({ width: frameSize, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let px = 0; px < frameSize; px++) {
      const si = (y * src.width + col * frameSize + px) * 4;
      const di = (y * frameSize + px) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

function writePng(dstPath, png) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, PNG.sync.write(png));
}

function walkDirsNamed(root, name, acc = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (!e.isDirectory()) continue;
    if (e.name === name) acc.push(full);
    else walkDirsNamed(full, name, acc);
  }
  return acc;
}

function listPngs(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.png') && e.name !== 'icon.png') out.push(full);
    }
  }
  return out;
}

function rmDirIfEmpty(dir) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
}

function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function processPair(sitFile, plopFile, sitAnimDir) {
  const fname = path.basename(sitFile);
  const parsed = parseFilename(fname);
  if (!parsed) return { status: 'error', reason: 'parse_sit', fname };

  const plopParsed = parseFilename(path.basename(plopFile));
  if (!plopParsed) return { status: 'error', reason: 'parse_plop', fname };

  const frameSize = parsed.frameSize;
  const sitPng = PNG.sync.read(fs.readFileSync(sitFile));
  const plopPng = PNG.sync.read(fs.readFileSync(plopFile));

  const sitCols = Math.floor(sitPng.width / frameSize);
  const plopCols = Math.floor(plopPng.width / frameSize);
  if (sitCols < 1 || plopCols < 2) {
    return { status: 'error', reason: `cols sit=${sitCols} plop=${plopCols}`, fname };
  }

  // F0 from sit col0, F1 from plop col0, F2 from plop col1
  const frames = [
    cropCol(sitPng, frameSize, 0),
    cropCol(plopPng, frameSize, 0),
    cropCol(plopPng, frameSize, 1),
  ];
  sitPng.data = null;
  plopPng.data = null;

  const dirs = parsed.dirs != null ? `_${parsed.dirs}` : '';
  const outName = `${parsed.color}_${frameSize}_1${dirs}.png`;

  // sitFile: .../a[sit]/zN/file.png
  const zRel = path.relative(sitAnimDir, path.dirname(sitFile)); // zN or ''
  const itemDir = path.dirname(sitAnimDir); // parent of a[sit]

  if (isDryRun) {
    frames.forEach(f => { f.data = null; });
    return { status: 'ok', dry: true, fname, outName };
  }

  for (let i = 0; i < POSES.length; i++) {
    const pose = POSES[i];
    const animDir = path.join(itemDir, pose.folder);
    const outDir = zRel ? path.join(animDir, zRel) : animDir;
    const outPath = path.join(outDir, outName);
    writePng(outPath, frames[i]);
    frames[i].data = null;
  }

  // remove source sit file if name differs or always remove old plop file
  // sit output overwrites a[sit]/zN/outName — delete old sit file if different name
  if (path.resolve(sitFile) !== path.resolve(path.join(path.dirname(sitFile), outName))) {
    try { fs.unlinkSync(sitFile); } catch { /* */ }
  }
  try { fs.unlinkSync(plopFile); } catch { /* */ }

  return { status: 'ok', fname, outName };
}

console.log(`=== resplit sit poses${isDryRun ? ' (dry-run)' : ''} ===`);

const sitDirs = walkDirsNamed(PROJECT, 'a[sit]');
console.log(`a[sit] folders: ${sitDirs.length}`);

let ok = 0, err = 0, skip = 0;
const errors = [];

for (const sitDir of sitDirs) {
  const itemDir = path.dirname(sitDir);
  const plopDir = path.join(itemDir, 'a[plop]');
  if (!fs.existsSync(plopDir)) {
    skip++;
    continue;
  }

  const sitFiles = listPngs(sitDir);
  for (const sitFile of sitFiles) {
    const rel = path.relative(sitDir, sitFile); // zN/name.png
    const plopFile = path.join(plopDir, rel);
    // plop may have _64_2_ while sit has _64_1_
    let plopResolved = plopFile;
    if (!fs.existsSync(plopResolved)) {
      const base = path.basename(sitFile).replace(/_(\d+)_1_/, '_$1_2_').replace(/_(\d+)_1\./, '_$1_2.');
      plopResolved = path.join(path.dirname(plopFile), base);
    }
    // also try replace _1_ with _2_ in full basename pattern
    if (!fs.existsSync(plopResolved)) {
      const p = parseFilename(path.basename(sitFile));
      if (p) {
        const dirs = p.dirs != null ? `_${p.dirs}` : '';
        const alt = `${p.color}_${p.frameSize}_2${dirs}.png`;
        plopResolved = path.join(path.dirname(plopFile), alt);
      }
    }
    if (!fs.existsSync(plopResolved)) {
      err++;
      errors.push({ fname: path.basename(sitFile), reason: 'plop_missing' });
      if (errors.length <= 15) console.warn('  ! plop missing', path.relative(PROJECT, sitFile));
      continue;
    }

    try {
      const r = processPair(sitFile, plopResolved, sitDir);
      if (r.status === 'ok') {
        ok++;
        if (ok <= 6 || ok % 1000 === 0) console.log(`  [${ok}] ${r.fname} → sit / sit_lounge / sit_lady`);
      } else {
        err++;
        errors.push(r);
        if (errors.length <= 15) console.warn('  !', r.fname, r.reason);
      }
    } catch (e) {
      err++;
      errors.push({ fname: path.basename(sitFile), reason: e.message });
      if (errors.length <= 15) console.warn('  !', path.basename(sitFile), e.message);
    }
  }
}

// remove empty / leftover a[plop] trees
if (!isDryRun) {
  const plopDirs = walkDirsNamed(PROJECT, 'a[plop]');
  for (const d of plopDirs) {
    removeTree(d);
  }
  console.log(`removed a[plop] folders: ${plopDirs.length}`);
}

console.log(`\n  ok: ${ok}`);
console.log(`  skip (no plop): ${skip}`);
console.log(`  error: ${err}`);
console.log(isDryRun ? 'dry-run done.' : 'done. next: node build-index.js ULPC');
if (err > 0) process.exitCode = 1;
