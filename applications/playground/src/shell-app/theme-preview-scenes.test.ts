import { describe, expect, it } from 'bun:test';

import { discoverExamples } from '../discover.ts';
import { THEME_PREVIEW_EXAMPLE_LOADERS } from './theme-preview-example-loaders.ts';
import {
  DEFAULT_THEME_PREVIEW_SCENE_ID,
  THEME_PREVIEW_CATEGORIES,
  THEME_PREVIEW_SCENES,
  THEME_PREVIEW_STATES,
  themePreviewExampleIds,
  themePreviewSceneById,
  themePreviewScenesInCategory,
} from './theme-preview-scenes.ts';

describe('the preview scene manifest', () => {
  it('has exactly the eight categories, in order', () => {
    expect([...THEME_PREVIEW_CATEGORIES]).toEqual([
      'Foundations',
      'Components',
      'Forms',
      'Data',
      'Feedback',
      'Overlay',
      'Charts',
      'Application',
    ]);
    const used = new Set(THEME_PREVIEW_SCENES.map((scene) => scene.category));
    expect([...used].toSorted()).toEqual([...THEME_PREVIEW_CATEGORIES].toSorted());
  });

  it('has unique scene ids prefixed by their category', () => {
    const ids = THEME_PREVIEW_SCENES.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scene of THEME_PREVIEW_SCENES) {
      expect(scene.id.startsWith(`${scene.category.toLowerCase()}/`)).toBe(true);
    }
  });

  it('references only examples that exist in the playground example sources', async () => {
    const ids = themePreviewExampleIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const [component, scenario] = id.split('/');
      expect(await discoverExamples(component!)).toContain(scenario!);
    }
  });

  it('covers every example the issue lists', () => {
    const listed = [
      'button/variants',
      'link/basic',
      'input/basic',
      'input/with-error',
      'select/basic',
      'select/with-error',
      'checkbox/basic',
      'checkbox/with-error',
      'tabs/basic',
      'callout/variants',
      'table/basic',
      'line-chart/multi-series',
      'modal/with-form',
      'popover/basic',
    ];
    expect(themePreviewExampleIds()).toEqual(expect.arrayContaining(listed));
  });

  it('backs every category except Foundations with at least one example', () => {
    for (const category of THEME_PREVIEW_CATEGORIES) {
      const scenes = themePreviewScenesInCategory(category);
      expect(scenes.length).toBeGreaterThan(0);
      for (const scene of scenes) {
        expect(scene.examples.length > 0).toBe(category !== 'Foundations');
      }
    }
  });

  it('opens on Components with button/variants selected', () => {
    const scene = themePreviewSceneById(DEFAULT_THEME_PREVIEW_SCENE_ID);
    expect(scene?.category).toBe('Components');
    expect(scene?.examples).toEqual(['button/variants']);
  });

  it('composes the Application scene from the settings form, then the summary and overlay actions', () => {
    const scene = themePreviewSceneById('application/settings-dashboard');
    expect(scene?.examples).toEqual([
      'input/basic',
      'select/basic',
      'checkbox/basic',
      'button/variants',
      'callout/variants',
      'table/basic',
      'line-chart/multi-series',
      'modal/with-form',
      'popover/basic',
    ]);
  });

  it('records every state for every scene, as applicable or with a reason', () => {
    for (const scene of THEME_PREVIEW_SCENES) {
      expect(Object.keys(scene.states).toSorted()).toEqual([...THEME_PREVIEW_STATES].toSorted());
      for (const support of Object.values(scene.states)) {
        if (support.applicable) expect(['rendered', 'interaction']).toContain(support.reach);
        else expect(support.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks invalid only on the error scenes', () => {
    const invalid = THEME_PREVIEW_SCENES.filter((scene) => scene.states.invalid.applicable).map(
      (scene) => scene.id,
    );
    expect(invalid).toEqual([
      'forms/input-with-error',
      'forms/select-with-error',
      'forms/checkbox-with-error',
    ]);
  });

  it('has a lazy loader for exactly the examples the scenes reference', () => {
    expect(Object.keys(THEME_PREVIEW_EXAMPLE_LOADERS).toSorted()).toEqual(
      [...themePreviewExampleIds()].toSorted(),
    );
  });
});
