import { DEFAULT_THEME_PREVIEW_SCENE_ID, themePreviewSceneById } from './theme-preview-scenes.ts';

/** The scene the preview frame is showing; the builder changes it over the message channel. */
export class ThemePreviewSceneState {
  id = $state(DEFAULT_THEME_PREVIEW_SCENE_ID);

  constructor(initialId?: string | null) {
    if (initialId != null && themePreviewSceneById(initialId) !== undefined) this.id = initialId;
  }
}
