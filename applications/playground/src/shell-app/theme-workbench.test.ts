/// <reference lib="dom" />
/**
 * DOM-level tests for the theme workbench shell: landmarks, the status area, the
 * selection contract (a scene change never changes the selected token), and the
 * Edit/Preview/Checks tabs below 768px. Pixel geometry and page overflow at 1440, 768,
 * 390, and 320px belong to the Playwright specs, which run in a real browser.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { firstFoundationPath, rowsInGroup } from './theme-builder-catalogue.ts';
import { layoutForWidth } from './theme-workbench-layout.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';
import ThemeWorkbench from './theme-workbench.svelte';

setupHappyDom();

type HappyWindow = Window & {
  happyDOM?: { setViewport: (viewport: { width: number; height: number }) => void };
};

function setViewport(width: number): void {
  (window as HappyWindow).happyDOM?.setViewport({ width, height: 900 });
}

let mounted: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

async function render(workbench = new ThemeWorkbenchState()): Promise<ThemeWorkbenchState> {
  mounted = mount(ThemeWorkbench, { target, props: { workbench, previewPath: 'about:blank' } });
  flushSync();
  await tick();
  return workbench;
}

beforeEach(() => {
  setViewport(1440);
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(() => {
  if (mounted !== null) void unmount(mounted);
  mounted = null;
  target.remove();
  setViewport(1440);
});

const byTestId = (id: string): HTMLElement | null => target.querySelector(`[data-testid="${id}"]`);

function tokenButton(path: string): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(`[data-token-path="${path}"]`);
  if (button === null) throw new Error(`no catalogue row for ${path}`);
  return button;
}

describe('layout breakpoints', () => {
  test.each([
    [1440, 'desktop'],
    [1200, 'desktop'],
    [1199, 'tablet'],
    [768, 'tablet'],
    [767, 'mobile'],
    [390, 'mobile'],
    [320, 'mobile'],
  ] as const)('%ipx uses the %s layout', (width, layout) => {
    expect(layoutForWidth(width)).toBe(layout);
  });
});

describe('the workbench shell', () => {
  test('exposes the toolbar, category navigation, catalogue, editor, preview, and checks', async () => {
    await render();
    expect(target.querySelector('h1')?.textContent).toBe('Theme builder');
    expect(target.querySelector('nav[aria-label="Token categories"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="Draft status"]')).not.toBeNull();
    expect(target.querySelector('#catalogue-heading')?.textContent).toBe('Token catalogue');
    expect(byTestId('editor-slot')).not.toBeNull();
    expect(target.querySelector('iframe[title="Theme preview"]')).not.toBeNull();
    expect(target.querySelector('#checks-heading')?.textContent).toBe('Checks');
    expect(target.querySelector('button[disabled]')?.textContent).toContain('Export');
  });

  test('keeps focus order: toolbar, categories, catalogue, editor, preview, checks', async () => {
    await render();
    const order = [
      '#theme-builder-heading',
      'nav[aria-label="Token categories"]',
      '#catalogue-heading',
      '#editor-heading',
      '#preview-heading',
      '#checks-heading',
    ].map((selector) => {
      const node = target.querySelector(selector);
      if (node === null) throw new Error(`missing ${selector}`);
      return node;
    });
    for (let index = 1; index < order.length; index += 1) {
      const relation = order[index - 1]!.compareDocumentPosition(order[index]!);
      expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test('shows the save state, findings count, and preview revision', async () => {
    const workbench = await render();
    expect(byTestId('save-state')?.textContent?.trim()).toBe('Saved locally');
    expect(byTestId('findings-count')?.textContent?.trim()).toBe('0 findings');
    expect(byTestId('preview-revision')?.textContent).toContain('Preview revision 0');
    workbench.saveStatus = 'unsaved';
    workbench.findingsCount = 1;
    workbench.setContext({ colorMode: 'dark', motion: 'default' });
    flushSync();
    expect(byTestId('save-state')?.textContent?.trim()).toBe('Unsaved locally');
    expect(byTestId('findings-count')?.textContent?.trim()).toBe('1 finding');
    expect(byTestId('preview-revision')?.textContent).toContain('Preview revision 1');
  });

  test('shows concrete color mode and motion selectors that drive the context', async () => {
    const workbench = await render();
    const colorMode = target.querySelector<HTMLSelectElement>('#theme-builder-color-mode')!;
    const motion = target.querySelector<HTMLSelectElement>('#theme-builder-motion')!;
    expect([...colorMode.options].map((option) => option.value)).toEqual(['light', 'dark']);
    expect([...motion.options].map((option) => option.value)).toEqual([
      'default',
      'reduced',
      'forced-reduced-motion',
    ]);
    colorMode.value = 'dark';
    colorMode.dispatchEvent(new Event('change', { bubbles: true }));
    motion.value = 'reduced';
    motion.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(workbench.context).toEqual({ colorMode: 'dark', motion: 'reduced' });
  });
});

describe('selection', () => {
  test('starts on the first foundation token, in the registry source order', async () => {
    const workbench = await render();
    expect(workbench.selectedTokenPath).toBe(firstFoundationPath());
    expect(byTestId('selected-token-path')?.textContent).toBe(firstFoundationPath()!);
  });

  test('a catalogue row selects a token, and a scene change leaves it alone', async () => {
    const workbench = await render();
    const second = rowsInGroup('foundations')[1]!;
    tokenButton(second.path).click();
    flushSync();
    expect(workbench.selectedTokenPath).toBe(second.path);

    const scene = target.querySelector<HTMLSelectElement>('#theme-builder-preview-scene')!;
    const category = target.querySelector<HTMLSelectElement>('#theme-builder-preview-category')!;
    const revisionBefore = workbench.revision;
    category.value = 'Forms';
    category.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(workbench.sceneId).toBe('forms/input-basic');
    scene.value = 'forms/select-with-error';
    scene.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(workbench.sceneId).toBe('forms/select-with-error');
    expect(workbench.revision).toBeGreaterThan(revisionBefore);
    expect(workbench.selectedTokenPath).toBe(second.path);
    expect(byTestId('selected-token-path')?.textContent).toBe(second.path);
  });

  test('the store keeps token, context, scene, and pane independent', () => {
    const workbench = new ThemeWorkbenchState();
    const token = workbench.selectedTokenPath;
    workbench.selectScene('overlay/popover-basic');
    workbench.setContext({ colorMode: 'dark', motion: 'forced-reduced-motion' });
    workbench.setPane('checks');
    workbench.selectGroup('components');
    expect(workbench.selectedTokenPath).toBe(token);
    expect(workbench.revision).toBe(2);
    const revision = workbench.revision;
    workbench.selectScene('overlay/popover-basic');
    workbench.setContext({ colorMode: 'dark', motion: 'forced-reduced-motion' });
    workbench.selectScene('not-a-scene');
    expect(workbench.revision).toBe(revision);
    workbench.setProperties([{ name: '--cinder-space-0', value: '1px' }]);
    expect(workbench.revision).toBe(revision + 1);
    expect(workbench.selectedTokenPath).toBe(token);
  });

  test('tracks preview acknowledgements and named rejections', () => {
    const workbench = new ThemeWorkbenchState();
    expect(workbench.previewIsStale).toBe(true);
    workbench.noteApplied(0);
    expect(workbench.previewIsStale).toBe(false);
    workbench.setProperties([]);
    expect(workbench.previewIsStale).toBe(true);
    workbench.noteRejected({ code: 'too-many-properties', message: 'too many' });
    expect(workbench.preview).toMatchObject({
      phase: 'error',
      appliedRevision: 0,
      error: { code: 'too-many-properties' },
    });
  });
});

describe('the catalogue', () => {
  test('switches groups from the rail and filters by text', async () => {
    const workbench = await render();
    const radius = rowsInGroup('foundations').filter((row) => row.path.includes('radius'));
    const filter = target.querySelector<HTMLInputElement>('#theme-builder-token-filter')!;
    filter.value = 'radius';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(byTestId('catalogue-count')?.textContent).toBe(`${radius.length} tokens in foundations`);
    const rail = [...target.querySelectorAll<HTMLButtonElement>('nav button')];
    rail.find((button) => button.textContent?.includes('Components'))!.click();
    flushSync();
    expect(workbench.groupId).toBe('components');
    expect(
      rail
        .find((button) => button.textContent?.includes('Components'))!
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  test('marks the selected row for assistive technology, not by color alone', async () => {
    await render();
    const selected = tokenButton(firstFoundationPath()!);
    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(selected.textContent).toContain('Selected');
  });

  test('uses the desktop table at 1440px and stacked rows below 1200px', async () => {
    await render();
    expect(target.querySelector('table')).not.toBeNull();
    expect(target.querySelectorAll('th[scope="col"]')).toHaveLength(6);
    void unmount(mounted!);
    mounted = null;
    target.replaceChildren();
    setViewport(768);
    await render();
    expect(target.querySelector('table')).toBeNull();
    expect(target.querySelector('ul[aria-label^="Tokens in"]')).not.toBeNull();
  });
});

describe('the Edit, Preview, and Checks tabs below 768px', () => {
  async function renderMobile(): Promise<ThemeWorkbenchState> {
    setViewport(390);
    return render();
  }

  test('shows three directly visible tabs and one visible pane', async () => {
    await renderMobile();
    const tabs = [...target.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Edit', 'Preview', 'Checks']);
    const panels = [...target.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true, true]);
    for (const tab of tabs) {
      const controls = tab.getAttribute('aria-controls')!;
      expect(target.querySelector(`#${controls}`)?.getAttribute('role')).toBe('tabpanel');
    }
  });

  test('keeps the preview mounted while another tab shows, and preserves selection and context', async () => {
    const workbench = await renderMobile();
    const frame = target.querySelector('iframe');
    tokenButton(rowsInGroup('foundations')[1]!.path).click();
    workbench.setContext({ colorMode: 'dark', motion: 'reduced' });
    flushSync();
    const tab = (name: string) =>
      [...target.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (candidate) => candidate.textContent?.trim() === name,
      )!;
    tab('Preview').click();
    flushSync();
    expect(workbench.pane).toBe('preview');
    expect(target.querySelector('#theme-builder-pane-edit')?.hasAttribute('hidden')).toBe(true);
    expect(target.querySelector('#theme-builder-pane-preview')?.hasAttribute('hidden')).toBe(false);
    expect(target.querySelector('iframe')).toBe(frame);
    tab('Edit').click();
    flushSync();
    expect(workbench.selectedTokenPath).toBe(rowsInGroup('foundations')[1]!.path);
    expect(workbench.context).toEqual({ colorMode: 'dark', motion: 'reduced' });
    expect(target.querySelector('iframe')).toBe(frame);
  });

  test('restores the scroll position of the pane that was hidden', async () => {
    const workbench = await renderMobile();
    window.scrollTo(0, 240);
    const tab = (name: string) =>
      [...target.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (candidate) => candidate.textContent?.trim() === name,
      )!;
    tab('Checks').click();
    flushSync();
    expect(workbench.scrollByPane.edit).toBe(240);
    window.scrollTo(0, 0);
    tab('Edit').click();
    flushSync();
    // load-proof: the editors flush through Svelte and the in-memory evaluator, so the update settles inside the microtask queue
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.scrollY).toBe(240);
  });

  test('does not render tabs on the tablet and desktop layouts', async () => {
    await render();
    expect(target.querySelector('[role="tablist"]')).toBeNull();
    expect(target.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
  });
});
