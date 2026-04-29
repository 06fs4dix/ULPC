# NEW_ULPC Viewer — 구조 및 버그 수정 기록

## 뷰어 파일 구조

```
viewer/
├── index.html
├── app.js              ← 진입점, 초기화
├── state.js            ← 전역 상태
├── data/
│   └── loader.js       ← index.json 로드, 트리/아이템맵 빌드, 파일명 파싱
├── canvas/
│   ├── animation.js    ← rAF 루프, 프레임 어드밴스, ANIM_META
│   ├── renderer.js     ← 다중 레이어 합성 렌더러
│   └── download.js     ← JSON / 전체 시트 PNG 다운로드
└── ui/
    ├── tree.js         ← 폴더 트리 렌더, 선택/해제 로직, 썸네일 지연 로딩
    ├── colorPicker.js  ← 선택 패널, 컬러 선택
    ├── animControls.js ← 애니메이션 컨트롤 UI
    └── search.js       ← 검색/바디타입 필터
```

---

## 핵심 데이터 흐름

```
index.json
  └─ buildTree(files)   → state.tree    (UI 폴더 트리용)
  └─ buildItemMap(files)→ state.itemMap (prefix → 파일 목록)

선택: state.selections = { "head/p[heads]/p[human]/p[male]": { color: null }, ... }

렌더: renderCharacter()
  1. selections의 각 prefix → getItemInfo() → animData 추출
  2. 전체 레이어의 maxFrameSize 계산
  3. offscreen canvas(maxFrameSize × maxFrameSize)에 z순 합성
  4. preview canvas에 zoom 배율로 복사
```

---

## 아이템 선택 규칙 (tree.js)

### 다중 선택 원칙
- 카테고리 내 여러 파츠를 **동시에 선택 가능** (head = base + eyes + nose + ears 등 합성)
- 단, **같은 z값을 가진 아이템 선택 시 기존 것을 자동 해제** (같은 레이어 교체)

### 중간 노드 선택
- 트리 노드가 자식 폴더를 가지면서 동시에 `itemMap`에 파일이 있는 경우 (예: `p[katana]`) 선택 버튼과 펼치기 버튼이 **모두 표시**됨
- 체크 아이콘 클릭 → 선택/해제
- 텍스트/화살표 클릭 → 펼치기/접기

---

## 렌더링 규칙 (renderer.js)

### 오버사이즈(128px) + 표준(64px) 혼합 합성
- 선택된 레이어 중 `maxFrameSize`를 먼저 계산 (64 또는 128)
- offscreen canvas를 `maxFrameSize × maxFrameSize`로 고정
- 각 레이어 그릴 때 `offset = (maxFrameSize - layer.frameSize) / 2` 적용 → 중앙 정렬

```
예) maxFrameSize=128, body(64px): offset=32 → (32,32)에 그림
    katana(128px): offset=0  → (0,0)에 그림
```

### 개별 애니메이션 PNG 구조
각 PNG는 **해당 애니메이션만** 포함한 개별 파일:
- width: frameSize × frameCount (열 수)
- height: frameSize × dirCount (행 수, hurt/climb은 1행)
- srcX = frameIndex × frameSize
- srcY = direction × frameSize (0=up, 1=left, 2=down, 3=right)

### 오버사이즈 PNG 열 수 주의
128px 오버사이즈 PNG는 **항상 13열** (shoot 최대 기준 고정 폭):
- 파일명: `default_128_13.png` → frameCount=13
- 그러나 walk는 실제 9프레임, slash는 6프레임만 사용
- `getFrameCount()`는 `ANIM_META[animName].frameCount`로 상한 적용

### canvas 크기 처리 (2025-04-25 수정)
- preview canvas **attribute 크기**는 `maxFrameSize`(64 or 128)로 고정
- **zoom은 CSS `style.width/height`로만** 처리 → HTML 레이아웃 변동 방지
- `index.html` `.canvas-wrap`에 `height: 320px` 고정 → zoom 변경 시 wrapper 크기 안정

---

## 애니메이션 프레임 규칙 (animation.js)

### ANIM_META cycle 배열
원본 `ANIMATION_CONFIGS`(constants.js) 기준 실제 재생 프레임 인덱스:

| 애니메이션 | cycle | 비고 |
|---|---|---|
| walk | [1,2,3,4,5,6,7,8] | frame 0은 idle 자세 → 스킵 |
| idle | [0,0,1] | frame 0을 2번 홀드 |
| jump | [0,1,2,3,4,1] | 착지 후 frame 1로 복귀 |
| sit | [0,0,0,0,0,1,1,1,1,1,2,2,2,2,2] | 각 프레임 5번 홀드 |
| emote | [0,0,0,0,0,1,1,1,1,1,2,2,2,2,2] | 각 프레임 5번 홀드 |
| backslash | [0,1,2,3,4,5,7,8,9,10,11,12] | frame 6 스킵 |
| 나머지 | 0부터 순차 | |

### walk frame 0
- PNG에 존재하지만 재생하지 않음
- idle 자세(양발 모은 서있는 포즈)
- CParserULPC에서도 동일하게 스킵: `fStart = (animName === "walk") ? 1 : 0`

---

## 버그 수정 이력

### 이미지 URL 오류 수정 (2025-04-25)

**증상**: 트리에서 아이템 선택 시 애니메이션이 전혀 표시되지 않음.

**원인**: `renderer.js`와 `tree.js`에서 이미지 URL 생성 시 `pathPrefix('ULPC/')`를 제거한 뒤
`imageBase('../spritesheets/')`와 합쳐서 경로를 구성했으나, 실제 파일은
`../spritesheets/ULPC/arms/...`에 있어 URL이 `../spritesheets/arms/...`로 잘못 생성됨.

**수정**:
- `renderer.js` `renderCharacter()` / `renderFullSheet()`: `pathPrefix` 제거 로직 삭제, `filePath` 전체를 `imageBase`에 합침
- `tree.js` `_drawThumb()`: 동일하게 수정

```js
// 수정 전
const relativePath = pathPrefix ? layer.filePath.slice(pathPrefix.length) : layer.filePath;
const url = imageBase + encodeFilePath(relativePath);

// 수정 후
const url = imageBase + encodeFilePath(layer.filePath);
```

---

### canvas 크기 변동 수정 (2025-04-25)

**증상**: 아이템 선택 시 오른쪽 미리보기 영역이 커졌다 작아졌다 함.

**원인**: `renderer.js`에서 preview canvas의 `width`/`height` **attribute**를
`maxFrameSize × zoom`으로 직접 변경 → HTML 레이아웃 재계산 발생.

**수정**:
- canvas attribute는 `maxFrameSize`(64 or 128)로 고정
- zoom은 `canvas.style.width/height`(CSS)로만 처리
- `index.html` `.canvas-wrap`에 `height: 320px` 고정

```js
// canvas attribute = offscreen 픽셀 크기로 고정
ctx.canvas.width  = maxFrameSize;
ctx.canvas.height = maxFrameSize;
// zoom은 CSS style로
ctx.canvas.style.width  = `${displaySize}px`;
ctx.canvas.style.height = `${displaySize}px`;
// offscreen → preview 1:1 복사
ctx.drawImage(offscreen, 0, 0, maxFrameSize, maxFrameSize);
```

---

### behind 레이어 z값 오류 수정 (2025-04-25)

**증상**: katana를 선택하면 안 보임. katana(z140)와 katana/p[behind](z140)가 같은 z값이라
뷰어에서 동시 선택 불가 (한 쪽 선택 시 다른 쪽 자동 해제).

**근본 원인 (extract-ulpc.js 버그)**:
`mapFile()`에서 `postAnimSegs`(behind 등)가 있을 때 `lookupPath`를
`preAnimSegs + postAnimSegs`로 구성하여 animation name을 누락함.

item-metadata.js는 `"weapon/sword/katana/slash/behind"` 처럼 **animation name 포함** 경로로
zPos를 정의하므로, `"weapon/sword/katana/behind"`로 조회하면 매칭 실패 →
category fallback `weapon` = z140 적용.

```js
// 수정 전 (extract-ulpc.js)
const lookupPath = [...preAnimSegs, ...postAnimSegs].join('/');
// → "weapon/sword/katana/behind" (animation name 누락 → z140 fallback)

// 수정 후
const lookupPath = postAnimSegs.length > 0
  ? [...preAnimSegs, animName, ...postAnimSegs].join('/')
  : [...preAnimSegs].join('/');
// → "weapon/sword/katana/slash/behind" (zMap 정확 매칭 → z9)
```

**임시 수정 (spritesheets 폴더 이동 + index.json)**:
`extract-ulpc.js` 재실행 전까지 다음 8개 파일을 z140 → z9로 수동 이동:
```
weapons/p[weapon]/p[ranged]/p[slingshot]/p[behind]/a[shoot]_1024/z9/default_64_13.png
weapons/p[weapon]/p[ranged]/p[slingshot]/p[behind]/a[walk]_512/z9/default_64_9.png
weapons/p[weapon]/p[sword]/p[katana]/p[behind]/a[slash]_768/z9/default_128_13.png
weapons/p[weapon]/p[sword]/p[katana]/p[behind]/a[walk]_512/z9/default_128_13.png
weapons/p[weapon]/p[sword]/p[longsword_alt]/p[behind]/a[slash]_768/z9/default_128_13.png
weapons/p[weapon]/p[sword]/p[longsword_alt]/p[behind]/a[walk]_512/z9/default_128_13.png
weapons/p[weapon]/p[sword]/p[scimitar]/p[behind]/a[slash]_768/z9/default_128_13.png
weapons/p[weapon]/p[sword]/p[scimitar]/p[behind]/a[walk]_512/z9/default_128_13.png
```

---

## behind 무기 합성 방법

오버사이즈 검류(katana, longsword_alt, scimitar)는 **front + behind 2개를 동시 선택**해야 완전한 합성:

| 선택 경로 | z값 | 표시 방향 |
|---|---|---|
| `weapons/.../p[katana]` | z140 | down (정면) |
| `weapons/.../p[katana]/p[behind]` | z9 | up/left/right (나머지) |

- behind(z9)는 body(z10)보다 낮아서 몸 뒤에 그려짐
- front(z140)는 모든 레이어 위에 그려짐
- 각 방향별로 둘 중 하나만 픽셀이 존재하도록 스프라이트가 설계됨

---

## 트리 썸네일 (tree.js) — 2025-04-25 추가

리프 아이템 행 옆에 **20×20px 픽셀 아트 썸네일**을 표시한다.

### 동작 방식
- 각 리프 노드(및 `hasFiles` 중간 노드)에 `<canvas width="20" height="20">` 삽입
- `IntersectionObserver`로 뷰포트에 들어올 때만 이미지 로드 (지연 로딩, rootMargin=120px)
- 로드한 이미지는 `_imgCache`(Map)에 캐시 → 같은 PNG를 여러 항목이 공유해도 1회만 요청

### 대표 파일 선택 우선순위
`walk → idle → combat_idle → slash → thrust → spellcast → shoot` 순으로 첫 번째 일치 파일 사용.

### 프레임 좌표
- srcX = 0 (첫 프레임)
- srcY = 2 × frameSize (down 방향, index 2)
- hurt / climb: 방향 없음 → srcY = 0
- `image-rendering: pixelated` 적용

---

## JSON 다운로드 (download.js) — 2025-04-25 추가

"Download Frame PNG" 버튼을 **"Download JSON"** 으로 교체.

### 출력 형식 (`ulpc_selection.json`)

```json
{
  "selections": [
    {
      "path": "arms/p[armour]/p[plate]/p[female]",
      "color": "steel",
      "files": [
        "arms/p[armour]/p[plate]/p[female]/a[walk]_512/z60/metal.ulpc.steel_64_9.png",
        "arms/p[armour]/p[plate]/p[female]/a[slash]_768/z60/metal.ulpc.steel_64_6.png"
      ]
    }
  ],
  "palettes": {
    "metal": {
      "ulpc": {
        "steel": ["#1d131e", "#4d4a5d", "#726b7e", "#867e7f", "#c4b59f", "#ffffff"]
      }
    }
  }
}
```

### 데이터 구성 규칙
- `selections[].files`: `itemMap[prefix]` 중 선택된 컬러와 일치하는 파일만 포함 (`parseFilename`으로 컬러 매칭)
- `palettes`: 포함된 파일들의 material/version/color 조합만 추출 (전체 팔레트 테이블 아님)
- default 아이템(팔레트 없음)은 files에는 포함되지만 palettes에는 항목 없음
- `parseFilename`은 `loader.js`에서 import해서 재사용

---

## 전체 시트 렌더링 (renderer.js — renderFullSheet)

### 방식: 애니메이션별 가변 블록 쌓기 (2025-04-25 개선)

yOffset 고정값을 제거하고, **애니메이션 순서대로 실제 블록 높이를 계산해서 세로로 쌓는** 방식으로 교체.

#### 기존 방식의 문제
- `animData.yOffset`이 64px 기준 고정값(walk=512, slash=768 …)
- maxFrameSize=128일 때 walk가 4행 × 128px = 512px를 차지 → y=1024까지 사용
- 그런데 slash는 yOffset=768에 그대로 배치 → **walk와 slash 영역 겹침**

#### 새 방식 (3-pass)

```
Pass 1: 아이템 전체 순회 → 애니메이션별 maxFrameSize / frameCount 수집
  animMeta["walk"]  = { maxFrameSize: 128, frameCount: 9, dirCount: 4 }
  animMeta["slash"] = { maxFrameSize: 128, frameCount: 6, dirCount: 4 }
  animMeta["spellcast"] = { maxFrameSize: 64, frameCount: 7, dirCount: 4 }

Pass 2: ANIM_ORDER 순서대로 Y 오프셋 누적
  spellcast: y=0,    블록높이 = 4 × 64  = 256
  thrust:    y=256,  블록높이 = 4 × 64  = 256
  walk:      y=512,  블록높이 = 4 × 128 = 512   ← 오버사이즈 아이템 포함 시
  slash:     y=1024, 블록높이 = 4 × 128 = 512
  ...

Pass 3: 각 레이어를 해당 블록에 중앙 정렬 후 합성
  64px 아이템 in 128px 블록: offset = (128-64)/2 = 32
```

#### 시트 크기
- 폭: `13 × globalMaxFrameSize` (전체 선택 중 최대 frameSize 기준 13열)
- 높이: 실제 등장한 애니메이션 블록 높이 합산 (빈 애니메이션 제외)

#### 버그 수정 이력
- `offscreen.convertToBlob()` → `new Promise(res => offscreen.toBlob(res, 'image/png'))`
  - `renderFullSheet()`는 `HTMLCanvasElement`를 반환하므로 `convertToBlob`(OffscreenCanvas 전용) 사용 불가

---

## 알려진 제약사항

1. **해당 애니메이션 없는 아이템**: 선택된 아이템이 현재 애니메이션을 지원하지 않으면 해당 아이템만 안 보임 (에러 메시지 표시). 예) katana는 walk/slash만 있음 → spellcast 선택 시 katana 미표시

2. **behind walk down 방향**: `p[behind]` walk의 down 방향은 스프라이트 자체가 투명 (몸에 가려지므로 의도된 동작)

3. **color 선택 없을 때**: `sel.color === null`이면 itemMap의 첫 번째 컬러 자동 사용

4. **전체 시트 Y 순서**: 시트의 Y 오프셋은 `ANIM_ORDER` 배열 순서 고정 (RESTRUCTURE.md 기준과 동일). 단, 해당 애니메이션을 가진 아이템이 없으면 그 블록은 아예 생략됨.
