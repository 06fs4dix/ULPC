/**
 * animation.js — rAF 기반 애니메이션 루프
 */
import { state } from '../state.js';
import { renderCharacter } from './renderer.js';
import { parseFilename } from '../data/loader.js';

// ANIM_META: 애니메이션별 yOffset, dirCount, frameCount
export const ANIM_META = {
  spellcast:   { yOffset: 0,    dirCount: 4, frameCount: 7  },
  thrust:      { yOffset: 256,  dirCount: 4, frameCount: 8  },
  walk:        { yOffset: 512,  dirCount: 4, frameCount: 8  },
  slash:       { yOffset: 768,  dirCount: 4, frameCount: 6  },
  shoot:       { yOffset: 1024, dirCount: 4, frameCount: 13 },
  hurt:        { yOffset: 1280, dirCount: 1, frameCount: 6  },
  climb:       { yOffset: 1344, dirCount: 1, frameCount: 6  },
  idle:        { yOffset: 1408, dirCount: 4, frameCount: 3  },
  jump:        { yOffset: 1664, dirCount: 4, frameCount: 6  },
  sit:         { yOffset: 1920, dirCount: 4, frameCount: 3  },
  emote:       { yOffset: 2176, dirCount: 4, frameCount: 3  },
  run:         { yOffset: 2432, dirCount: 4, frameCount: 8  },
  combat_idle: { yOffset: 2688, dirCount: 4, frameCount: 3  },
  backslash:   { yOffset: 2944, dirCount: 4, frameCount: 12 },
  halfslash:   { yOffset: 3200, dirCount: 4, frameCount: 6  },
};

export const ANIM_NAMES = Object.keys(ANIM_META);

let rafId = null;
let lastTime = 0;
let previewCtx = null;
let frameChangeCallback = null;

export function initAnimation(canvas, onFrameChange) {
  previewCtx = canvas.getContext('2d');
  frameChangeCallback = onFrameChange || null;
}

export function startAnimation() {
  if (rafId) return;
  state.isAnimating = true;
  lastTime = performance.now();
  rafId = requestAnimationFrame(loop);
}

export function stopAnimation() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state.isAnimating = false;
}

function loop(now) {
  const fps       = state.fps || 10;
  const interval  = 1000 / fps;
  const elapsed   = now - lastTime;

  if (elapsed >= interval) {
    lastTime = now - (elapsed % interval);
    advanceFrame();
    if (previewCtx) {
      renderCharacter(previewCtx, state.currentFrame);
    }
    if (frameChangeCallback) frameChangeCallback(state.currentFrame);
  }

  rafId = requestAnimationFrame(loop);
}

function advanceFrame() {
  const animName   = state.selectedAnimation || 'walk';
  const frameCount = getFrameCount(animName);
  state.currentFrame = (state.currentFrame + 1) % frameCount;
}

/**
 * 현재 선택된 아이템들에서 해당 애니메이션의 실제 프레임 수를 파일명에서 읽어옴.
 */
function getFrameCount(animName) {
  if (!state.itemMap) return ANIM_META[animName]?.frameCount || 4;

  let maxFrames = 0;
  for (const prefix of Object.keys(state.selections)) {
    const files = state.itemMap[prefix] || [];
    for (const f of files) {
      const segs = f.split('/');
      const aIdx = segs.findIndex(s => /^a\[/.test(s));
      if (aIdx < 0) continue;
      const m = segs[aIdx].match(/^a\[(.+)\]$/);
      if (!m || m[1] !== animName) continue;
      const fname = segs[aIdx + 2];
      if (!fname) continue;
      const parsed = parseFilename(fname);
      if (parsed?.frameCount > 0) maxFrames = Math.max(maxFrames, parsed.frameCount);
    }
  }
  return maxFrames > 0 ? maxFrames : (ANIM_META[animName]?.frameCount || 4);
}

/** 애니메이션 변경 시 프레임 리셋 */
export function resetFrame() {
  state.currentFrame = 0;
}
