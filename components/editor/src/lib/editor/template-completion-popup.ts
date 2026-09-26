import type { EditorView } from 'prosemirror-view';

import { acceptSuggestion } from './template-completion-acceptance.js';
import type { CompletionState } from './template-completion-state.js';

export function createPopupElement(): HTMLElement {
  const popup = document.createElement('div');
  popup.className = 'template-completion-popup';
  popup.setAttribute('role', 'listbox');
  popup.style.position = 'absolute';
  popup.style.zIndex = '50';
  popup.style.display = 'none';
  return popup;
}

export function renderSuggestions(
  popup: HTMLElement,
  completionState: CompletionState,
  view: EditorView,
): void {
  popup.textContent = '';
  const { suggestions, activeIndex, tokenFrom } = completionState;
  for (let index = 0; index < suggestions.length; index++) {
    const candidate = suggestions[index];
    if (!candidate) continue;
    const item = document.createElement('div');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === activeIndex));
    item.className = 'template-completion-item';
    if (index === activeIndex) item.classList.add('template-completion-item--active');

    const pathLabel = document.createElement('span');
    pathLabel.className = 'template-completion-item-path';
    pathLabel.textContent = candidate.path;
    item.appendChild(pathLabel);
    if (candidate.description || candidate.valueKind !== 'unknown') {
      const secondary = document.createElement('span');
      secondary.className = 'template-completion-item-description';
      const parts: string[] = [];
      if (candidate.valueKind && candidate.valueKind !== 'unknown') parts.push(candidate.valueKind);
      if (candidate.description) parts.push(candidate.description);
      secondary.textContent = parts.join(' — ');
      item.appendChild(secondary);
    }
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      acceptSuggestion(view, candidate, tokenFrom);
    });
    popup.appendChild(item);
  }
}

export function positionPopup(popup: HTMLElement, view: EditorView, cursorPos: number): void {
  const coordinates = view.coordsAtPos(cursorPos);
  const parentElement = popup.parentElement;
  if (!parentElement) return;
  const parentRect = parentElement.getBoundingClientRect();
  popup.style.left = `${coordinates.left - parentRect.left}px`;
  popup.style.top = `${coordinates.bottom - parentRect.top + 4}px`;
}
