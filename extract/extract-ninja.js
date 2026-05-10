'use strict';
/**
 * extract-ninja.js — NinjaAdventure/Actor → spritesheets/NinjaAdventure/
 *
 * 카테고리별 처리:
 *   Character  : SeparateAnim/ 우선, 없으면 SpriteSheet.png 슬라이스
 *                64x112 → walk(64x64)+attack(64x16)+jump(64x16)+dead/item/s1/s2(16x16)
 *                64x64  → walk 4방향, 64x32 → walk 2방향
 *   Monster    : SpriteSheet.png 또는 {name}.png (64x64) → walk 4방향
 *   Animal     : SpriteSheet*.png (다양한 크기) → walk / walk_side
 *   Boss       : Walk/Attack/Idle/Hit/Jump/Charge 등 개별 파일
 *
 * 출력 경로:
 *   spritesheets/NinjaAdventure/{Cat}/p[{Name}]/a[{anim}]/z0/{colorId}_{fs}_{fc}_{dirs}.png
 *
 * 방향 인코딩 (ULPC 표준 행 순서 N→W→S→E):
 *   '0213' = 4방향, '1' = 앞(남) 단방향, '2' = 좌(서) 단방향
 */

const fs   = require('fs');
const path = require('path');
const PNG  = require('pngjs').PNG;

const isDryRun = process.argv.includes('--dry-run');

const ACTOR_DIR   = path.join(__dirname, '../../NinjaAdventure/Actor');
const OUT_SPRITES = path.join(__dirname, '../spritesheets');
const PROJECT     = 'NinjaAdventure';
const OUT_ROOT    = path.join(OUT_SPRITES, PROJECT);

// ─── 방향 상수 ────────────────────────────────────────────────────────────────
const DIRS_4  = '1023'; // 방향 인코딩: row0=S(1), row1=N(0), row2=W(2), row3=E(3)
const DIRS_1  = '1';    // 남/앞 단방향
const DIRS_2  = '2';    // 서/좌 단방향 (Side 파일)

// ─── PNG 헤더 읽기 ─────────────────────────────────────────────────────────────
function readDim(f) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(f, 'r');
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ─── 파일 I/O ─────────────────────────────────────────────────────────────────
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writePNG(dst, dstPath) {
  ensureDir(path.dirname(dstPath));
  fs.writeFileSync(dstPath, PNG.sync.write(dst));
  dst.data = null;
}

function copyPNG(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

// 소스 PNG에서 (x, y, w, h) 영역을 잘라 저장
function cropAndSave(srcPath, dstPath, x, y, w, h) {
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const si = ((y + row) * src.width + (x + col)) * 4;
      const di = (row * w + col) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  src.data = null;
  writePNG(dst, dstPath);
}

// NinjaAdventure walk 레이아웃 변환: (col=방향, row=프레임) → (row=방향, col=프레임)
//
// 원본:           변환 후:
//  [앞f0][왼f0]    [앞f0][앞f1][앞f2][앞f3]  ← 앞(row0)
//  [앞f1][왼f1]    [왼f0][왼f1][왼f2][왼f3]  ← 왼(row1)
//  [앞f2][왼f2]    ...
//  [앞f3][왼f3]
//
// cropX/Y: 소스 PNG 내 crop 시작점 (0,0이면 전체)
// numDirs: 방향 수 (= 원본 열 수)
// numFrames: 프레임 수 (= 원본 행 수)
// cellSize: 셀 크기(px)
function transposeCells(srcPath, dstPath, cropX, cropY, cellSize, numDirs, numFrames) {
  const src  = PNG.sync.read(fs.readFileSync(srcPath));
  const dstW = numFrames * cellSize;
  const dstH = numDirs   * cellSize;
  const dst  = new PNG({ width: dstW, height: dstH });

  for (let d = 0; d < numDirs; d++) {
    for (let f = 0; f < numFrames; f++) {
      // src 셀: col=d, row=f  →  dst 셀: col=f, row=d
      for (let py = 0; py < cellSize; py++) {
        for (let px = 0; px < cellSize; px++) {
          const si = ((cropY + f * cellSize + py) * src.width + (cropX + d * cellSize + px)) * 4;
          const di = ((d * cellSize + py) * dstW + (f * cellSize + px)) * 4;
          dst.data[di]     = src.data[si];
          dst.data[di + 1] = src.data[si + 1];
          dst.data[di + 2] = src.data[si + 2];
          dst.data[di + 3] = src.data[si + 3];
        }
      }
    }
  }
  src.data = null;
  writePNG(dst, dstPath);
}

// ─── 출력 경로 생성 ────────────────────────────────────────────────────────────
function buildDst(cat, charName, animName, colorId, frameSize, frameCount, dirs) {
  const fname = `${colorId}_${frameSize}_${frameCount}_${dirs}.png`;
  return path.join(OUT_ROOT, cat, `p[${charName}]`, `a[${animName}]`, 'z0', fname);
}

// ─── SpriteSheet 파일명 파싱 ──────────────────────────────────────────────────
// 'SpriteSheet'        → { colorId: 'default', side: false }
// 'SpriteSheetYellow'  → { colorId: 'variant.v1.yellow', side: false }
// 'SpriteSheetYellowSide' → { colorId: 'variant.v1.yellow', side: true }
function parseSpriteSheetStem(stem) {
  // 대소문자 변형(SpriteShee 등 오타) 정규화
  const normalized = stem.replace(/^spritesheet/i, 'SpriteSheet');
  if (!normalized.startsWith('SpriteSheet')) return null;

  let suffix = normalized.slice('SpriteSheet'.length);
  let side = false;

  if (suffix.endsWith('Side')) {
    side = true;
    suffix = suffix.slice(0, -4);
  }

  const colorId = suffix ? `variant.v1.${suffix.toLowerCase()}` : 'default';
  return { colorId, side };
}

// ─── 수집 결과 ────────────────────────────────────────────────────────────────
const ops      = []; // { kind, srcPath, dstPath, ... }
const skipped  = [];
const warnings = [];

function addCopy(srcPath, dstPath) {
  ops.push({ kind: 'copy', srcPath, dstPath });
}
function addCrop(srcPath, dstPath, x, y, w, h) {
  ops.push({ kind: 'crop', srcPath, dstPath, crop: { x, y, w, h } });
}
// 4방향 walk 전치: src(col=방향,row=프레임) → dst(row=방향,col=프레임)
function addTranspose(srcPath, dstPath, cropX, cropY, cellSize, numDirs, numFrames) {
  ops.push({ kind: 'transpose', srcPath, dstPath, cropX, cropY, cellSize, numDirs, numFrames });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Character 처리 ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// SeparateAnim/{AnimName}.png → a[{animname}]
// dirs=DIRS_4: col=방향(4), row=프레임 → 전치하여 row=방향, col=프레임
// dirs=DIRS_1: 이미 좌→우 단방향, 그대로 복사
const SEPARATE_ANIM_MAP = {
  'walk':     { anim: 'walk',     dirs: DIRS_4, frameSize: 16 },
  'idle':     { anim: 'idle',     dirs: DIRS_4, frameSize: 16 }, // 4방향×1프레임: 64×16 → 16×64
  'jump':     { anim: 'jump',     dirs: DIRS_4, frameSize: 16 }, // 4방향×1프레임: 64×16 → 16×64
  'attack':   { anim: 'attack',   dirs: DIRS_4, frameSize: 16 }, // 4방향×1프레임: 64×16 → 16×64
  'dead':     { anim: 'dead',     dirs: DIRS_1, frameSize: 16 },
  'item':     { anim: 'item',     dirs: DIRS_1, frameSize: 16 },
  'special1': { anim: 'special1', dirs: DIRS_1, frameSize: 16 },
  'special2': { anim: 'special2', dirs: DIRS_1, frameSize: 16 },
};

function processCharacterSeparateAnim(charDir, charName) {
  const sepDir = path.join(charDir, 'SeparateAnim');
  if (!fs.existsSync(sepDir)) return false;

  for (const fname of fs.readdirSync(sepDir)) {
    if (!fname.endsWith('.png')) continue;
    const stem = path.basename(fname, '.png').toLowerCase();
    const meta = SEPARATE_ANIM_MAP[stem];
    if (!meta) {
      warnings.push(`Character/${charName}/SeparateAnim/${fname}: 알 수 없는 애니메이션`);
      continue;
    }
    const srcPath = path.join(sepDir, fname);
    const { w, h } = readDim(srcPath);
    const dirsVal  = meta.dirs;

    let frameCount, dstPath;
    if (dirsVal === DIRS_4) {
      // NinjaAdventure walk 레이아웃: col=방향(4), row=프레임(4)
      // → 전치하여 row=방향, col=프레임으로 변환
      const numDirs = 4, numFrames = h / meta.frameSize;
      frameCount = numFrames;
      dstPath = buildDst('Character', charName, meta.anim, 'default', meta.frameSize, frameCount, dirsVal);
      addTranspose(srcPath, dstPath, 0, 0, meta.frameSize, numDirs, numFrames);
    } else {
      // 단방향 애니메이션: 이미 좌→우 순서
      frameCount = Math.round(w / meta.frameSize);
      dstPath = buildDst('Character', charName, meta.anim, 'default', meta.frameSize, frameCount, dirsVal);
      addCopy(srcPath, dstPath);
    }
  }
  return true;
}

// SpriteSheet.png (no SeparateAnim) → 슬라이스
function processCharacterSpriteSheet(charDir, charName) {
  // SpriteSheet 파일 탐색 (이름이 다를 수 있음)
  let sheetFile = null;
  for (const fname of fs.readdirSync(charDir)) {
    if (!fname.endsWith('.png')) continue;
    const stem = fname.replace('.png', '');
    if (stem.toLowerCase().includes('spritesheet') || stem.toLowerCase() === charName.toLowerCase() + 'spritesheet') {
      sheetFile = path.join(charDir, fname);
      break;
    }
    // 캐릭터명과 동일한 이름의 단일 PNG (예: redsamurai.png)
    if (stem.toLowerCase() === charName.toLowerCase()) {
      sheetFile = path.join(charDir, fname);
      break;
    }
    // 파일이 Faceset이 아닌 다른 PNG
    if (!stem.startsWith('Faceset') && !stem.startsWith('faceset')) {
      sheetFile = path.join(charDir, fname);
      break;
    }
  }

  if (!sheetFile || !fs.existsSync(sheetFile)) return;

  const { w, h } = readDim(sheetFile);
  const FRAME = 16;

  if (w === 64 && h === 112) {
    // walk (y=0..63): col=방향(4), row=프레임(4) → 전치
    addTranspose(sheetFile, buildDst('Character', charName, 'walk', 'default', FRAME, 4, DIRS_4), 0, 0,  FRAME, 4, 4);
    // attack: 4방향×1프레임 → 전치하여 위→아래 (64×16 → 16×64)
    addTranspose(sheetFile, buildDst('Character', charName, 'attack', 'default', FRAME, 1, DIRS_4), 0, 64, FRAME, 4, 1);
    // jump: 4방향×1프레임 → 전치하여 위→아래 (64×16 → 16×64)
    addTranspose(sheetFile, buildDst('Character', charName, 'jump',   'default', FRAME, 1, DIRS_4), 0, 80, FRAME, 4, 1);
    addCrop(sheetFile, buildDst('Character', charName, 'dead',     'default', FRAME, 1, DIRS_1), 0, 96,  16, 16);
    addCrop(sheetFile, buildDst('Character', charName, 'item',     'default', FRAME, 1, DIRS_1), 16, 96, 16, 16);
    addCrop(sheetFile, buildDst('Character', charName, 'special1', 'default', FRAME, 1, DIRS_1), 32, 96, 16, 16);
    addCrop(sheetFile, buildDst('Character', charName, 'special2', 'default', FRAME, 1, DIRS_1), 48, 96, 16, 16);
  } else if (w === 64 && h === 64) {
    addTranspose(sheetFile, buildDst('Character', charName, 'walk', 'default', FRAME, 4, DIRS_4), 0, 0, FRAME, 4, 4);
  } else if (w === 64 && h === 32) {
    // 2방향 walk: col=방향(4), row=프레임(2) → 전치 → row=방향(4개중 2개), col=프레임
    addTranspose(sheetFile, buildDst('Character', charName, 'walk', 'default', FRAME, 4, '12'), 0, 0, FRAME, 4, 2);
  } else {
    // 알 수 없는 크기 → 그대로 복사 (frameSize=h, frameCount=w/h)
    const frameCount = Math.round(w / h) || 1;
    addCopy(sheetFile, buildDst('Character', charName, 'walk', 'default', h, frameCount, DIRS_1));
    warnings.push(`Character/${charName}: 비표준 SpriteSheet ${w}x${h} → walk 단방향으로 처리`);
  }
}

function processCharacterDir(catDir) {
  for (const charName of fs.readdirSync(catDir)) {
    const charDir = path.join(catDir, charName);
    const stat = fs.statSync(charDir);
    if (!stat.isDirectory()) {
      if (charName.endsWith('.png')) skipped.push(`Character/${charName}`);
      continue;
    }
    const hasSeparateAnim = processCharacterSeparateAnim(charDir, charName);
    if (!hasSeparateAnim) {
      processCharacterSpriteSheet(charDir, charName);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Monster 처리 ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function processMonsterDir(catDir) {
  const FRAME = 16;
  for (const monName of fs.readdirSync(catDir)) {
    const monDir = path.join(catDir, monName);
    if (!fs.statSync(monDir).isDirectory()) continue;

    for (const fname of fs.readdirSync(monDir)) {
      if (!fname.endsWith('.png')) continue;
      const stem = path.basename(fname, '.png');
      if (stem.startsWith('Faceset') || stem.startsWith('faceset')) continue;

      const srcPath = path.join(monDir, fname);
      const { w, h } = readDim(srcPath);

      if (w === 64 && h === 64) {
        // Monster walk: col=방향(4), row=프레임(4) → 전치
        const dstPath = buildDst('Monster', monName, 'walk', 'default', FRAME, 4, DIRS_4);
        addTranspose(srcPath, dstPath, 0, 0, FRAME, 4, 4);
      } else {
        const frameCount = Math.round(w / h) || 1;
        const dstPath = buildDst('Monster', monName, 'walk', 'default', h, frameCount, DIRS_1);
        addCopy(srcPath, dstPath);
        warnings.push(`Monster/${monName}/${fname}: 비표준 ${w}x${h} → walk 단방향`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Animal 처리 ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function detectFrameCount(w, h) {
  // 너비가 16의 배수이면 16px 열 분할 우선 (높이가 16의 배수가 아니어도 적용)
  // 예: 32x23 → frameSize=16, frameCount=2, dirCount=1 (Lion 류)
  if (w % 16 === 0) {
    const dirCount = Math.max(1, Math.round(h / 16));
    return { frameSize: 16, frameCount: w / 16, dirCount };
  }
  // 너비가 16 배수가 아닌 경우: 높이 기반 탐색
  for (const fs of [h, h - 1, h + 1, h - 2, h + 2, 20, 24, 12]) {
    if (fs > 0 && w % fs === 0) {
      return { frameSize: fs, frameCount: w / fs, dirCount: Math.round(h / fs) || 1 };
    }
  }
  // 완전 fallback
  return { frameSize: h, frameCount: 1, dirCount: 1 };
}

function processAnimalDir(catDir) {
  for (const animalName of fs.readdirSync(catDir)) {
    const animalDir = path.join(catDir, animalName);
    if (!fs.statSync(animalDir).isDirectory()) continue;

    for (const fname of fs.readdirSync(animalDir)) {
      if (!fname.endsWith('.png')) continue;
      const rawStem = path.basename(fname, '.png');

      // Faceset 계열 제외
      if (rawStem.toLowerCase().startsWith('faceset')) continue;

      // 오타 정규화 (SpriteShee → SpriteSheet)
      const stem = rawStem.replace(/^SpriteShee(?!t)/i, 'SpriteSheet');

      const parsed = parseSpriteSheetStem(stem);
      if (!parsed) {
        warnings.push(`Animal/${animalName}/${fname}: SpriteSheet이 아닌 파일 — 건너뜀`);
        continue;
      }

      const srcPath = path.join(animalDir, fname);
      const { w, h } = readDim(srcPath);
      const { frameSize, frameCount, dirCount } = detectFrameCount(w, h);
      let dirsVal;
      if (parsed.side) {
        dirsVal = DIRS_2; // 서/좌 방향 단방향
      } else if (dirCount >= 4) {
        dirsVal = DIRS_4;
      } else {
        dirsVal = DIRS_1;
      }

      const animName = parsed.side ? 'walk_side' : 'walk';
      const dstPath  = buildDst('Animal', animalName, animName, parsed.colorId, frameSize, frameCount, dirsVal);
      addCopy(srcPath, dstPath);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Boss 처리 ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// 건너뛸 파일 패턴 (포트레이트, 컴포넌트 파츠 등)
const BOSS_SKIP = new Set([
  'faceset', 'sprite', 'preview',
  'body1', 'body2', 'bodyend', 'head', 'wing',
]);

function processBossDir(catDir) {
  for (const bossName of fs.readdirSync(catDir)) {
    const bossDir = path.join(catDir, bossName);
    if (!fs.statSync(bossDir).isDirectory()) continue;

    for (const fname of fs.readdirSync(bossDir)) {
      if (!fname.endsWith('.png')) continue;
      const stem = path.basename(fname, '.png');
      if (BOSS_SKIP.has(stem.toLowerCase())) continue;

      const srcPath = path.join(bossDir, fname);
      const { w, h } = readDim(srcPath);

      // frame height = sprite height (Boss 프레임은 정사각형 h×h 셀로 가정)
      const frameSize  = h;
      const frameCount = w % h === 0 ? w / h : Math.round(w / h) || 1;
      const animName   = stem.toLowerCase().replace(/[^a-z0-9]/g, '_');

      const dstPath = buildDst('Boss', bossName, animName, 'default', frameSize, frameCount, DIRS_1);
      addCopy(srcPath, dstPath);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── 메인: 카테고리 순회 ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
console.log('=== NinjaAdventure 추출 시작 ===');
if (isDryRun) console.log('[DRY-RUN 모드: 파일 복사 없음]\n');

const categoryDirs = fs.readdirSync(ACTOR_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name);

console.log(`카테고리: ${categoryDirs.join(', ')}\n`);

for (const cat of categoryDirs) {
  const catDir = path.join(ACTOR_DIR, cat);
  console.log(`처리 중: ${cat}/`);
  switch (cat) {
    case 'Character':         processCharacterDir(catDir);    break;
    case 'Monster':           processMonsterDir(catDir);      break;
    case 'Animal':            processAnimalDir(catDir);       break;
    case 'Boss':              processBossDir(catDir);         break;
    case 'CharacterAnimated': skipped.push(`${cat}/ (복합 시트 — 건너뜀)`); break;
    default:
      warnings.push(`알 수 없는 카테고리: ${cat}`);
  }
}

console.log(`\n수집: ${ops.length}개 작업 | 건너뜀: ${skipped.length}개 | 경고: ${warnings.length}개`);

// ─── 기존 출력 폴더 정리 ──────────────────────────────────────────────────────
if (!isDryRun && fs.existsSync(OUT_ROOT)) {
  console.log('기존 spritesheets/NinjaAdventure/ 삭제 중...');
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
}

// ─── 작업 실행 ────────────────────────────────────────────────────────────────
let done = 0, errors = 0;
const REPORT_INTERVAL = 200;

for (const op of ops) {
  if (!isDryRun) {
    try {
      if (op.kind === 'copy') {
        copyPNG(op.srcPath, op.dstPath);
      } else if (op.kind === 'crop') {
        const { x, y, w, h } = op.crop;
        cropAndSave(op.srcPath, op.dstPath, x, y, w, h);
      } else if (op.kind === 'transpose') {
        transposeCells(op.srcPath, op.dstPath, op.cropX, op.cropY, op.cellSize, op.numDirs, op.numFrames);
      }
      done++;
    } catch (err) {
      errors++;
      warnings.push(`오류: ${path.relative(ACTOR_DIR, op.srcPath)} → ${err.message}`);
    }
  } else {
    done++;
  }
  if (done % REPORT_INTERVAL === 0) {
    process.stdout.write(`  진행: ${done} / ${ops.length}\r`);
  }
}
process.stdout.write('\n');

// ─── 리포트 ───────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  console.log('\n── 경고 ──');
  warnings.slice(0, 20).forEach(w => console.log('  ⚠', w));
  if (warnings.length > 20) console.log(`  ... 외 ${warnings.length - 20}개`);
}
if (skipped.length > 0) {
  console.log('\n── 건너뜀 ──');
  skipped.slice(0, 10).forEach(s => console.log('  -', s));
}

console.log(`\n완료: ${done}개 처리 | 오류: ${errors}개`);

// ─── credits.json 생성 ────────────────────────────────────────────────────────
if (!isDryRun) {
  const readmeSrc = path.join(__dirname, '../../NinjaAdventure/README.md');
  const creditsDst = path.join(OUT_ROOT, 'credits.json');
  if (fs.existsSync(readmeSrc)) {
    ensureDir(OUT_ROOT);
    const credits = parseReadmeCredits(fs.readFileSync(readmeSrc, 'utf8'));
    fs.writeFileSync(creditsDst, JSON.stringify(credits, null, 2), 'utf8');
    console.log('  → credits.json 저장 완료 (spritesheets/NinjaAdventure/)');
  } else {
    console.log('  ⚠ README.md를 찾을 수 없어 credits.json 생성 건너뜀');
  }
}

// ─── README.md 파싱 → { Authors, Licenses, URLs } ────────────────────────────
function parseReadmeCredits(text) {
  const authors  = [];
  const licenses = [];
  const urls     = [];

  // Markdown 링크 추출: [Name](url)
  const mdLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;

  // 작성자 섹션: "Assets created by:" 이후 빈 줄 전까지
  const authorBlock = text.match(/assets created by:\s*([\s\S]*?)(?:\n\n|\n#)/i);
  if (authorBlock) {
    let m;
    mdLinkRe.lastIndex = 0;
    while ((m = mdLinkRe.exec(authorBlock[1])) !== null) {
      authors.push({ name: m[1].trim(), url: m[2].trim() });
    }
    // 링크 없는 일반 텍스트 이름도 수집
    const plainNames = authorBlock[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '') // 이미 처리된 링크 제거
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    for (const name of plainNames) {
      authors.push({ name, url: '' });
    }
  }

  // 라이선스: "CC0", "Creative Commons" 포함 줄 추출
  for (const line of text.split('\n')) {
    if (/creative commons|cc0|mit\b|apache|gpl|lgpl/i.test(line)) {
      // 괄호 포함 라이선스 식별자 추출 시도
      const licMatch = line.match(/Creative Commons[^.,()\n]*(Zero|\d\.\d)?[^.,()\n]*/i)
        || line.match(/\b(CC0|CC BY[^.,()\n]*|MIT|Apache[^.,()\n]*|GPL[^.,()\n]*)/i);
      if (licMatch) {
        const lic = licMatch[0].trim();
        if (!licenses.includes(lic)) licenses.push(lic);
      }
    }
  }

  // URL 섹션: "Label: https://..." 형태
  const urlLineRe = /^([^:\n]+):\s*(https?:\/\/\S+)/gm;
  let um;
  while ((um = urlLineRe.exec(text)) !== null) {
    urls.push({ label: um[1].trim(), url: um[2].trim() });
  }
  // Markdown 링크 형태의 URL도 수집 (작성자 섹션 외)
  mdLinkRe.lastIndex = 0;
  let lm;
  while ((lm = mdLinkRe.exec(text)) !== null) {
    const isAuthor = authors.some(a => a.url === lm[2].trim());
    if (!isAuthor) {
      urls.push({ label: lm[1].trim(), url: lm[2].trim() });
    }
  }

  return { Authors: authors, Licenses: licenses, URLs: urls };
}

// ─── index.json 생성 ─────────────────────────────────────────────────────────
if (!isDryRun && fs.existsSync(OUT_ROOT)) {
  console.log('\n=== index.json 생성 ===');

  // 파일 목록 수집 (OUT_ROOT 기준 상대경로)
  const files = [];
  function walkForIndex(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkForIndex(full);
      } else if (entry.name.endsWith('.png')) {
        files.push(path.relative(OUT_ROOT, full).replace(/\\/g, '/'));
      }
    }
  }
  walkForIndex(OUT_ROOT);
  files.sort();
  console.log(`파일 수: ${files.length}개`);

  // palette.json 로드 (없으면 빈 객체)
  const palPath = path.join(OUT_ROOT, 'palette.json');
  const palettes = fs.existsSync(palPath)
    ? JSON.parse(fs.readFileSync(palPath, 'utf8'))
    : {};

  const jsonPath = path.join(OUT_ROOT, 'index.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ files, palettes }), 'utf8');

  const sizeKB = (fs.statSync(jsonPath).size / 1024).toFixed(1);
  console.log(`✅ index.json 저장: ${jsonPath}`);
  console.log(`   크기: ${sizeKB} KB`);
}
