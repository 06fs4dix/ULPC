/**
 * zip-loader.js — ZIP 파일에서 프로젝트 데이터 로드
 *
 * 1. ZIP(URL 또는 File 객체) → JSZip(window.JSZip) 으로 파싱
 * 2. index.json 추출 → processIndexData()로 tree/itemMap 빌드
 * 3. credits.json 추출 (있으면) → 반환값에 포함
 * 4. 모든 PNG → Blob URL 생성 → state.zipBlobs(Map) 에 저장
 *    키: ZIP 내 상대 경로 (e.g. "Animal/p[Cat]/a[walk]/z0/default_16_2_1.png")
 * 5. 프로젝트 전환 시 clearZipBlobs()로 이전 Blob URL revoke
 */
import { processIndexData } from './loader.js';
import { state } from '../state.js';

/** 기존 Blob URL 전부 revoke 후 맵 초기화 */
export function clearZipBlobs() {
  for (const url of state.zipBlobs.values()) {
    URL.revokeObjectURL(url);
  }
  state.zipBlobs.clear();
}

/**
 * JSZip 인스턴스에서 공통 처리:
 * - index.json 파싱
 * - credits.json 추출 (선택)
 * - 모든 PNG → state.zipBlobs
 * 반환: { ...processIndexData 결과, credits }
 */
async function _processZip(zip) {
  // index.json 추출
  const indexFile = zip.file('index.json');
  if (!indexFile) throw new Error('index.json not found in ZIP');
  const idx = JSON.parse(await indexFile.async('text'));

  // credits.json 추출 (없으면 null)
  let credits = null;
  const creditsFile = zip.file('credits.json');
  if (creditsFile) {
    try { credits = JSON.parse(await creditsFile.async('text')); } catch { /* 무시 */ }
  }

  // 모든 PNG → Blob URL 병렬 추출
  const tasks = [];
  zip.forEach((relativePath, file) => {
    if (file.dir) return;
    if (!relativePath.toLowerCase().endsWith('.png')) return;
    tasks.push(
      file.async('blob').then(blob => {
        state.zipBlobs.set(relativePath, URL.createObjectURL(blob));
      })
    );
  });
  await Promise.all(tasks);

  return { ...processIndexData(idx), credits };
}

/**
 * URL에서 ZIP을 fetch해 로드한다.
 * 반환: { tree, itemMap, palettes, files, totalFiles, pathPrefix, credits }
 */
export async function loadFromZip(zipUrl) {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip not loaded (window.JSZip undefined)');

  const response = await fetch(zipUrl);
  if (!response.ok) throw new Error(`ZIP fetch failed: ${zipUrl} (${response.status})`);

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  return _processZip(zip);
}

/**
 * 로컬 File 객체에서 ZIP을 로드한다 (파일 선택 다이얼로그 용).
 * 반환: { tree, itemMap, palettes, files, totalFiles, pathPrefix, credits }
 */
export async function loadFromZipFile(file) {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip not loaded (window.JSZip undefined)');

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  return _processZip(zip);
}
