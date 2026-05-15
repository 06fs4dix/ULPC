'use strict';
/**
 * artginePreview.js — Artgine Preview 플로팅 팝업
 *
 * 버튼을 누를 때마다 새 팝업 창이 생성된다.
 * 현재 선택 상태를 base64 JSON으로 직렬화해 iframe URL에 전달한다.
 */
import { buildExportData } from './download.js';

const PREVIEW_BASE = 'https://06fs4dix.github.io/ULPC/viewer/';

let _zTop    = 1000;
let _cascade = 0;

export function initArtginePreview() {
  document.getElementById('btn-artgine-preview')
    ?.addEventListener('click', openPreview);
}

function openPreview() {
  const data = buildExportData(null);
  const json = JSON.stringify(data);
  const b64  = btoa(unescape(encodeURIComponent(json)));
  const url  = `${PREVIEW_BASE}?json=${b64}`;
  createPopup(url);
}

function createPopup(url) {
  const offset = (_cascade++ % 10) * 22;
  const z      = ++_zTop;

  const popup = document.createElement('div');
  Object.assign(popup.style, {
    position:      'fixed',
    left:          `${60 + offset}px`,
    top:           `${60 + offset}px`,
    width:         'min(920px, 92vw)',
    height:        'min(640px, 88vh)',
    zIndex:        z,
    display:       'flex',
    flexDirection: 'column',
    background:    '#fff',
    borderRadius:  '8px',
    boxShadow:     '0 10px 40px rgba(0,0,0,0.3)',
    overflow:      'hidden',
    resize:        'both',
  });

  // ── 타이틀바
  const bar = document.createElement('div');
  Object.assign(bar.style, {
    display:     'flex',
    alignItems:  'center',
    gap:         '8px',
    padding:     '5px 10px',
    background:  '#0d6efd',
    color:       '#fff',
    cursor:      'move',
    userSelect:  'none',
    flexShrink:  '0',
  });

  const ico = document.createElement('i');
  ico.className = 'bi bi-window';
  ico.style.cssText = 'font-size:0.85rem;';

  const title = document.createElement('span');
  title.textContent = 'Artgine Preview';
  title.style.cssText = 'flex:1; font-size:0.82rem; font-weight:600;';

  const btnOpen = document.createElement('button');
  btnOpen.title = 'Open in new tab';
  btnOpen.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
  _styleBarBtn(btnOpen);
  btnOpen.addEventListener('click', () => window.open(url, '_blank'));

  const btnClose = document.createElement('button');
  btnClose.title = 'Close';
  btnClose.innerHTML = '<i class="bi bi-x-lg"></i>';
  _styleBarBtn(btnClose);
  btnClose.addEventListener('click', () => popup.remove());

  bar.append(ico, title, btnOpen, btnClose);

  // ── iframe
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'flex:1; border:none; width:100%;';
  iframe.setAttribute('allow', 'cross-origin-isolated');

  popup.append(bar, iframe);
  document.body.appendChild(popup);

  // 클릭 시 최상위로
  popup.addEventListener('mousedown', () => {
    popup.style.zIndex = ++_zTop;
  }, true);

  _makeDraggable(popup, bar);
}

function _styleBarBtn(btn) {
  Object.assign(btn.style, {
    background:   'rgba(255,255,255,0.15)',
    border:       'none',
    color:        '#fff',
    borderRadius: '4px',
    padding:      '2px 6px',
    cursor:       'pointer',
    fontSize:     '0.78rem',
    lineHeight:   '1.4',
    flexShrink:   '0',
  });
}

function _makeDraggable(el, handle) {
  handle.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'I') return;
    e.preventDefault();

    const sx = e.clientX, sy = e.clientY;
    const sl = parseInt(el.style.left) || 0;
    const st = parseInt(el.style.top)  || 0;

    const onMove = e => {
      el.style.left = `${sl + e.clientX - sx}px`;
      el.style.top  = `${st + e.clientY - sy}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
