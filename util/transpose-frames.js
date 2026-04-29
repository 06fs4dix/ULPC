/**
 * transpose-frames.js
 * 프레임 배열 전치: 위→아래 배열을 왼쪽→오른쪽 배열로 변환
 *
 * 입력 레이아웃 (rows × cols):
 *   0  1
 *   2  3
 *
 * 출력 레이아웃 (cols × rows):
 *   0  2
 *   1  3
 *
 * 실행:
 *   node transpose-frames.js <input.png> <output.png> <frameSize>
 *
 * 예시:
 *   node transpose-frames.js Walk.png Walk_out.png 16
 */

import fs   from 'fs';
import path from 'path';
import { createRequire } from 'module';
const { PNG } = createRequire(import.meta.url)('../extract/node_modules/pngjs');

// ── 인수 파싱 ────────────────────────────────────────────────────────────────
const [,, inputFile, outputFile, frameSizeArg] = process.argv;

if (!inputFile || !outputFile || !frameSizeArg) {
  console.error('사용법: node transpose-frames.js <input.png> <output.png> <frameSize>');
  console.error('예시:   node transpose-frames.js walk_v.png walk.png 64');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`파일 없음: ${inputFile}`);
  process.exit(1);
}

const frameSize = parseInt(frameSizeArg, 10);
if (isNaN(frameSize) || frameSize <= 0) {
  console.error(`frameSize는 양의 정수여야 합니다: ${frameSizeArg}`);
  process.exit(1);
}

// ── PNG 읽기 ─────────────────────────────────────────────────────────────────
const src  = PNG.sync.read(fs.readFileSync(inputFile));
const srcW = src.width;
const srcH = src.height;

if (srcW % frameSize !== 0 || srcH % frameSize !== 0) {
  console.error(`이미지 크기(${srcW}×${srcH})가 frameSize(${frameSize})의 배수가 아닙니다.`);
  process.exit(1);
}

const cols = srcW / frameSize;  // 입력 열 수
const rows = srcH / frameSize;  // 입력 행 수

// ── 전치 (transpose) ──────────────────────────────────────────────────────────
// 입력 (rows × cols) → 출력 (cols × rows)
// 입력 셀(srcRow, srcCol) → 출력 셀(dstRow=srcCol, dstCol=srcRow)
const dstW = rows * frameSize;
const dstH = cols * frameSize;
const dst  = new PNG({ width: dstW, height: dstH });

for (let srcRow = 0; srcRow < rows; srcRow++) {
  for (let srcCol = 0; srcCol < cols; srcCol++) {
    const dstRow = srcCol;
    const dstCol = srcRow;

    for (let py = 0; py < frameSize; py++) {
      for (let px = 0; px < frameSize; px++) {
        const si = ((srcRow * frameSize + py) * srcW + (srcCol * frameSize + px)) * 4;
        const di = ((dstRow * frameSize + py) * dstW + (dstCol * frameSize + px)) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }
}

// ── 저장 ─────────────────────────────────────────────────────────────────────
const outDir = path.dirname(outputFile);
if (outDir && outDir !== '.' && !fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}
fs.writeFileSync(outputFile, PNG.sync.write(dst));

console.log(`입력:  ${srcW}×${srcH}  (${cols}열 × ${rows}행, frameSize=${frameSize})`);
console.log(`출력:  ${dstW}×${dstH}  (${rows}열 × ${cols}행, frameSize=${frameSize})`);
console.log(`저장:  ${outputFile}`);
