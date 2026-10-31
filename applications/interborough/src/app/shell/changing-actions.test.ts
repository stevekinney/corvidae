/**
 * The visible half of turning off changes while the server is unreachable: which controls are
 * disabled, that ones rendered later are too, and that going back leaves everything as it was.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHANGING_ACTION_SELECTOR, disableChangingActions } from './changing-actions.ts';

const roots: HTMLElement[] = [];
// A page left in the document would be read by the next file this process runs.
afterEach(() => {
  for (const root of roots.splice(0)) root.remove();
});

function page(markup: string): HTMLElement {
  const root = document.createElement('main');
  roots.push(root);
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}

describe('disableChangingActions', () => {
  test('disables submit buttons and marked controls, with the reason as their title, and nothing else', () => {
    const root = page(`
      <form><button type="submit" id="save">Save</button><button type="button" id="cancel">Cancel</button></form>
      <button type="button" data-changes id="delete">Delete</button>
      <button type="button" id="retry">Retry</button>
      <a href="/x" id="link">Link</a>`);
    const enable = disableChangingActions(root, 'Turned off');
    const byId = (id: string) => root.querySelector<HTMLButtonElement>(`#${id}`)!;
    expect(byId('save').disabled).toBe(true);
    expect(byId('save').title).toBe('Turned off');
    expect(byId('delete').disabled).toBe(true);
    expect(byId('cancel').disabled).toBe(false);
    expect(byId('retry').disabled).toBe(false);
    enable();
    expect(byId('save').disabled).toBe(false);
    expect(byId('save').hasAttribute('title')).toBe(false);
    expect(byId('delete').disabled).toBe(false);
  });

  test('disables a control rendered after the server went away', async () => {
    const root = page('<div id="slot"></div>');
    const enable = disableChangingActions(root, 'Turned off');
    root.querySelector('#slot')!.innerHTML = '<button type="submit" id="late">Late</button>';
    await waitUntil(() => root.querySelector<HTMLButtonElement>('#late')!.disabled, {
      message: 'the late control being disabled',
    });
    enable();
    expect(root.querySelector<HTMLButtonElement>('#late')!.disabled).toBe(false);
  });

  test('leaves a control that was already disabled, or keeps itself enabled, alone', () => {
    const root = page(`
      <button type="submit" id="off" disabled title="Needs the schedules scope">Off</button>
      <button type="submit" id="kept" data-keeps-enabled>Kept</button>`);
    const enable = disableChangingActions(root, 'Turned off');
    const off = root.querySelector<HTMLButtonElement>('#off')!;
    expect(off.title).toBe('Needs the schedules scope');
    expect(root.querySelector<HTMLButtonElement>('#kept')!.disabled).toBe(false);
    enable();
    expect(off.disabled).toBe(true);
    expect(off.title).toBe('Needs the schedules scope');
  });

  test('keeps a title the page gave a control and gives it back', () => {
    const root = page('<button type="submit" id="save" title="Save the schedule">Save</button>');
    const enable = disableChangingActions(root, 'Turned off');
    const save = root.querySelector<HTMLButtonElement>('#save')!;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Save the schedule');
    enable();
    expect(save.disabled).toBe(false);
    expect(save.title).toBe('Save the schedule');
  });

  test('names the selector it matches', () => {
    expect(CHANGING_ACTION_SELECTOR).toContain('[data-changes]');
  });
});
