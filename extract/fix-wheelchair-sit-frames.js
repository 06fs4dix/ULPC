'use strict';
/**
 * 휠체어 sit 시트를 ULPC 표준 sit 프레임 수(3)에 맞춤.
 * 현재: *_64_2_0213.png (128×256) → *_64_3_0213.png (192×256)
 * 부족 프레임은 마지막 프레임 반복.
 */
const fs   = require('fs');
const path = require('path');
const PNG  = require('pngjs').PNG;

const ROOT = path.join(__dirname, '../spritesheets/ULPC/body/p[wheelchair]');
const TARGET_FC = 3;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.png') && e.name !== 'icon.png') acc.push(full);
  }
  return acc;
}

function expandToFrames(srcPath, targetFc) {
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const base = path.basename(srcPath, '.png');
  const m = base.match(/_(\d+)_(\d+)_([0-3]+)$/);
  if (!m) throw new Error('bad name: ' + srcPath);

  const frameSize = Number(m[1]);
  const oldFc     = Number(m[2]);
  const dirs      = m[3];
  const srcCols   = Math.floor(src.width / frameSize);

  if (srcCols === targetFc && oldFc === targetFc) {
    return { skipped: true, name: path.basename(srcPath) };
  }

  const dst = new PNG({ width: targetFc * frameSize, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let col = 0; col < targetFc; col++) {
      const srcCol = Math.min(col, srcCols - 1); // pad with last frame
      for (let px = 0; px < frameSize; px++) {
        const si = (y * src.width  + srcCol * frameSize + px) * 4;
        const di = (y * dst.width  + col    * frameSize + px) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }

  const colorPart = base.replace(/_\d+_\d+_[0-3]+$/, '');
  const newName = `${colorPart}_${frameSize}_${targetFc}_${dirs}.png`;
  const newPath = path.join(path.dirname(srcPath), newName);
  fs.writeFileSync(newPath, PNG.sync.write(dst));
  if (path.resolve(newPath) !== path.resolve(srcPath)) fs.unlinkSync(srcPath);

  return {
    skipped: false,
    old: path.basename(srcPath),
    neu: newName,
    w: dst.width,
    h: dst.height,
  };
}

if (!fs.existsSync(ROOT)) {
  console.error('missing', ROOT);
  process.exit(1);
}

const files = walk(ROOT);
console.log(`wheelchair sheets: ${files.length}`);
for (const f of files) {
  const r = expandToFrames(f, TARGET_FC);
  if (r.skipped) console.log('  skip', r.name);
  else console.log(`  ${r.old} → ${r.neu} (${r.w}x${r.h})`);
}
console.log('done. run: node build-index.js ULPC');
