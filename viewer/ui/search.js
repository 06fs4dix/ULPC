/**
 * search.js — 검색 초기화
 */
import { state } from '../state.js';
import { applySearchToTree } from './tree.js';

export function initSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value.trim();
      applySearchToTree();
    }, 200);
  });
}
