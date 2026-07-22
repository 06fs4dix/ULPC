'use strict';
/**
 * generate-missing-icons.js
 *
 * 이미 추출된 spritesheets/<project>/ 에서 prefix별 icon.png 가 없으면
 * 스프라이트 시트(south, frame0)에서 잘라 생성한다.
 *
 * extract-ulpc 전체 재실행 없이 icon 누락만 채울 때 사용.
 * (a[all] 전용 아이템, 이전 파이프라인 스킵 등)
 *
 * 실행:
 *   node generate-missing-icons.js           # 전체 프로젝트
 *   node generate-missing-icons.js ULPC      # 특정 프로젝트
 *   node generate-missing-icons.js ULPC --dry-run
 */

const fs   = require('fs');
const path = require('path');
const PNG  = require('pngjs').PNG;

const SPRITES_ROOT = path.join(__dirname, '../spritesheets');
const isDryRun = process.argv.includes('--dry-run');
const targetProject = process.argv.slice(2).find(a => a !== '--dry-run') || null;

// idle > walk > … > all (extract-ulpc 와 동일)
const ICON_ANIM_PRIORITY = [
  'idle', 'walk', 'combat_idle', 'spellcast', 'slash', 'thrust', 'shoot', 'hurt', 'all',
];
const COLOR_PREF = ['white', 'light', 'default', 'steel', 'male', 'female', 'adult'];

function isFullyTransparent(png) {
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] > 0) return false;
  }
  return true;
}

/** loader.js parseFilename 과 동일한 규칙 (오른쪽부터 frameSize/frameCount/dirs) */
function parseFilename(fname) {
  const base = fname.replace(/\.png$/i, '');
  const t = base.split('_');
  if (t.length < 3) return null;

  let frameCount, frameSize, dirs, restTokens;
  const last = t[t.length - 1];
  const prev = t[t.length - 2];
  const prev2 = t[t.length - 3];

  // 신규: ..._frameSize_frameCount_dirs
  if (/^\d+$/.test(prev2) && (prev2 === '64' || prev2 === '128' || prev2 === '16' || prev2 === '32')
      && /^\d+$/.test(prev) && /^[0-3]+$/.test(last)) {
    dirs = last;
    frameCount = parseInt(prev, 10);
    frameSize = parseInt(prev2, 10);
    restTokens = t.slice(0, -3);
  } else if (/^\d+$/.test(prev) && (prev === '64' || prev === '128' || prev === '16' || prev === '32')
      && /^\d+$/.test(last)) {
    // 구형식: ..._frameSize_frameCount
    dirs = null;
    frameCount = parseInt(last, 10);
    frameSize = parseInt(prev, 10);
    restTokens = t.slice(0, -2);
  } else {
    return null;
  }
  if (!Number.isFinite(frameSize) || !Number.isFinite(frameCount)) return null;
  const color = restTokens.join('_') || 'default';
  return { color, frameSize, frameCount, dirs };
}

function cropFrame(src, frameSize, row) {
  const srcY = row * frameSize;
  if (srcY + frameSize > src.height || frameSize > src.width) return null;
  const dst = new PNG({ width: frameSize, height: frameSize });
  for (let py = 0; py < frameSize; py++) {
    for (let px = 0; px < frameSize; px++) {
      const si = ((srcY + py) * src.width + px) * 4;
      const di = (py * frameSize + px) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

/**
 * south(frame row of dir '1') 우선. 완전 투명이면 다른 방향 행을 순서대로 시도.
 * (fg 레이어 등 south 가 비어 있는 시트 대응)
 */
function extractIconFrame(srcPath, dstPath, frameSize, dirs) {
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const dirStr = dirs || '1';
  const rowCount = Math.floor(src.height / frameSize);
  const preferred = [];
  if (dirStr.includes('1')) preferred.push(dirStr.indexOf('1')); // south first
  for (let i = 0; i < dirStr.length; i++) {
    if (!preferred.includes(i)) preferred.push(i);
  }
  for (let r = 0; r < rowCount; r++) {
    if (!preferred.includes(r)) preferred.push(r);
  }

  let saved = false;
  for (const row of preferred) {
    const dst = cropFrame(src, frameSize, row);
    if (!dst) continue;
    if (isFullyTransparent(dst)) {
      dst.data = null;
      continue;
    }
    if (!isDryRun) {
      const dir = path.dirname(dstPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dstPath, PNG.sync.write(dst));
    }
    dst.data = null;
    saved = true;
    break;
  }
  src.data = null;
  return saved ? { ok: true } : { ok: false, reason: 'transparent' };
}

function walkPngs(dir, projectDir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPngs(full, projectDir, acc);
    else if (entry.name.endsWith('.png') && entry.name !== 'icon.png') {
      acc.push(path.relative(projectDir, full).replace(/\\/g, '/'));
    }
  }
  return acc;
}

function colorScore(color) {
  const c = (color || '').toLowerCase();
  const idx = COLOR_PREF.findIndex(p => c === p || c.startsWith(p + '.') || c.endsWith('_' + p));
  return idx >= 0 ? idx : COLOR_PREF.length + 1;
}

function pickBestSource(files) {
  // files: { rel, anim, parsed }[]
  let best = null;
  let bestKey = null;
  for (const f of files) {
    const animPri = ICON_ANIM_PRIORITY.indexOf(f.anim);
    const ap = animPri >= 0 ? animPri : ICON_ANIM_PRIORITY.length + 10;
    const cs = colorScore(f.parsed.color);
    const key = `${String(ap).padStart(3, '0')}_${String(cs).padStart(3, '0')}_${f.rel}`;
    if (!bestKey || key < bestKey) {
      bestKey = key;
      best = f;
    }
  }
  return best;
}

function processProject(project) {
  const projectDir = path.join(SPRITES_ROOT, project);
  console.log(`\n=== missing icons: ${project} ===`);

  const files = walkPngs(projectDir, projectDir);
  const byPrefix = new Map(); // prefix → [{rel, anim, parsed}]

  for (const rel of files) {
    const segs = rel.split('/');
    const aIdx = segs.findIndex(s => /^a\[/.test(s));
    if (aIdx < 0) continue;
    const animM = segs[aIdx].match(/^a\[(.+)\]$/);
    if (!animM) continue;
    const fname = segs[aIdx + 2];
    if (!fname) continue;
    const parsed = parseFilename(fname);
    if (!parsed) continue;
    const prefix = segs.slice(0, aIdx).join('/');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push({ rel, anim: animM[1], parsed });
  }

  let created = 0, skippedExists = 0, skippedTransparent = 0, errors = 0;

  for (const [prefix, list] of byPrefix) {
    const iconRel = `${prefix}/icon.png`;
    const iconAbs = path.join(projectDir, ...prefix.split('/'), 'icon.png');
    if (fs.existsSync(iconAbs)) {
      skippedExists++;
      continue;
    }

    const src = pickBestSource(list);
    if (!src) {
      errors++;
      continue;
    }

    const srcAbs = path.join(projectDir, ...src.rel.split('/'));
    try {
      const result = extractIconFrame(srcAbs, iconAbs, src.parsed.frameSize, src.parsed.dirs);
      if (result.ok) {
        created++;
        if (created <= 15 || src.anim === 'all') {
          console.log(`  + ${iconRel}  ← a[${src.anim}] ${path.basename(src.rel)}`);
        }
      } else if (result.reason === 'transparent') {
        skippedTransparent++;
      } else {
        errors++;
        console.warn(`  ! ${iconRel}: ${result.reason} (${src.rel})`);
      }
    } catch (err) {
      errors++;
      console.warn(`  ! ${iconRel}: ${err.message}`);
    }
  }

  console.log(`  prefixes: ${byPrefix.size}`);
  console.log(`  created: ${created}${isDryRun ? ' (dry-run)' : ''}`);
  console.log(`  already had icon: ${skippedExists}`);
  console.log(`  skipped transparent south frame0: ${skippedTransparent}`);
  console.log(`  errors: ${errors}`);
  return { created, skippedTransparent };
}

if (!fs.existsSync(SPRITES_ROOT)) {
  console.error(`❌ 폴더 없음: ${SPRITES_ROOT}`);
  process.exit(1);
}

const projects = fs.readdirSync(SPRITES_ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && (!targetProject || e.name === targetProject))
  .map(e => e.name);

if (projects.length === 0) {
  console.error(targetProject
    ? `❌ 프로젝트 폴더 없음: spritesheets/${targetProject}`
    : '❌ spritesheets/ 에 프로젝트 폴더가 없습니다.');
  process.exit(1);
}

let totalCreated = 0;
for (const p of projects) {
  const r = processProject(p);
  totalCreated += r.created;
}
console.log(`\n완료. 생성 ${totalCreated}개${isDryRun ? ' (dry-run, 파일 미기록)' : ''}.`);
console.log('다음: node build-index.js');
