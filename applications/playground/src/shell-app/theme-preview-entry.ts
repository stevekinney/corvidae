/**
 * Entry point for `/theme-builder/preview`, the trusted Cinder fixture document the
 * theme builder embeds. It mounts the scene and starts listening for validated messages.
 * `?scene=<id>` selects a scene when the page is opened on its own.
 */

import { mount } from 'svelte';

import ThemePreviewDocument from './theme-preview-document.svelte';
import { startThemePreviewFrame } from './theme-preview-frame.ts';
import { PUBLIC_THEME_PROPERTIES } from './theme-preview-properties.ts';
import { ThemePreviewSceneState } from './theme-preview-scene-state.svelte.ts';

const target = document.getElementById('theme-preview-root');
if (target === null) throw new Error('[theme preview] #theme-preview-root target not found');

const scene = new ThemePreviewSceneState(new URLSearchParams(window.location.search).get('scene'));

mount(ThemePreviewDocument, {
  target,
  props: {
    get sceneId() {
      return scene.id;
    },
  },
});

startThemePreviewFrame({
  window,
  allowedProperties: PUBLIC_THEME_PROPERTIES,
  onScene: (sceneId) => {
    scene.id = sceneId;
  },
});
