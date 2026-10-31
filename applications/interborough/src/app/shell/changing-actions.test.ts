/**
 * The visible half of holding back changes while the server is unreachable: which controls are
 * held, that ones rendered later are too, that the page's own `disabled` state is never read or
 * written, and that going back leaves everything as it was.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHANGING_ACTION_SELECTOR, holdChangingActions } from './changing-actions.ts';

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

const byId = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`#${id}`)!;

describe('holdChangingActions', () => {
  test('marks submit buttons and marked controls aria-disabled with the reason as their title, and nothing else', () => {
    const root = page(`
      <form><button type="submit" id="save">Save</button><button type="button" id="cancel">Cancel</button></form>
      <button type="button" data-changes id="delete">Delete</button>
      <button type="button" id="retry">Retry</button>
      <a href="/x" id="link">Link</a>`);
    const release = holdChangingActions(root, 'Turned off');
    expect(byId(root, 'save').getAttribute('aria-disabled')).toBe('true');
    expect(byId(root, 'save').title).toBe('Turned off');
    expect(byId(root, 'delete').getAttribute('aria-disabled')).toBe('true');
    expect(byId(root, 'cancel').hasAttribute('aria-disabled')).toBe(false);
    expect(byId(root, 'retry').hasAttribute('aria-disabled')).toBe(false);
    // The control stays focusable: it is held, not disabled.
    expect(byId(root, 'save').disabled).toBe(false);
    release();
    expect(byId(root, 'save').hasAttribute('aria-disabled')).toBe(false);
    expect(byId(root, 'save').hasAttribute('title')).toBe(false);
  });

  test('holds a control rendered after the server went away', async () => {
    const root = page('<div id="slot"></div>');
    const release = holdChangingActions(root, 'Turned off');
    root.querySelector('#slot')!.innerHTML = '<button type="submit" id="late">Late</button>';
    await waitUntil(() => byId(root, 'late').getAttribute('aria-disabled') === 'true', {
      message: 'the late control being held',
    });
    release();
    expect(byId(root, 'late').hasAttribute('aria-disabled')).toBe(false);
  });

  test('never writes the disabled property: a control the page keeps disabled stays so, and one it enables is enabled', () => {
    const root = page(`
      <button type="submit" id="off" disabled>Off</button>
      <button type="submit" id="edited" disabled>Edited</button>`);
    const release = holdChangingActions(root, 'Turned off');
    expect(byId(root, 'off').disabled).toBe(true);
    // The page enables Save on the first keystroke of the outage: still held, no longer disabled.
    byId(root, 'edited').disabled = false;
    expect(byId(root, 'edited').getAttribute('aria-disabled')).toBe('true');
    release();
    expect(byId(root, 'off').disabled).toBe(true);
    expect(byId(root, 'edited').disabled).toBe(false);
  });

  test('keeps an aria-disabled and a title the page gave a control, and gives them back', () => {
    const root = page(
      '<button type="submit" id="save" title="Save the schedule" aria-disabled="false">Save</button>',
    );
    const release = holdChangingActions(root, 'Turned off');
    const save = byId(root, 'save');
    expect(save.title).toBe('Save the schedule');
    expect(save.getAttribute('aria-disabled')).toBe('false');
    release();
    expect(save.title).toBe('Save the schedule');
    expect(save.getAttribute('aria-disabled')).toBe('false');
  });

  test('stops a click, Enter and a submit on a changing control before the page sees them, and only those', () => {
    const root = page(`
      <form id="form"><input id="field"><button type="submit" id="save">Save</button>
        <button type="button" id="cancel">Cancel</button></form>
      <button type="button" data-changes id="delete"><span id="inner">Delete</span></button>`);
    const reached: string[] = [];
    for (const id of ['save', 'cancel', 'delete']) {
      byId(root, id).addEventListener('click', () => reached.push(id));
    }
    root.querySelector('#form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      reached.push('submit');
    });
    const release = holdChangingActions(root, 'Turned off');

    byId(root, 'save').click();
    root.querySelector<HTMLElement>('#inner')!.click();
    byId(root, 'cancel').click();
    expect(reached).toEqual(['cancel']);

    // A submit the browser sends from Enter in a field names the form's submit button.
    const form = root.querySelector<HTMLFormElement>('#form')!;
    form.dispatchEvent(
      new SubmitEvent('submit', { submitter: byId(root, 'save'), cancelable: true }),
    );
    expect(reached).toEqual(['cancel']);

    release();
    byId(root, 'save').click();
    expect(reached).toEqual(['cancel', 'save', 'submit']);
  });

  test('a marked container does not hold the controls inside it', () => {
    const root = page(
      '<form data-changes><button type="button" id="inside">Inside</button></form>',
    );
    let clicks = 0;
    byId(root, 'inside').addEventListener('click', () => (clicks += 1));
    const release = holdChangingActions(root, 'Turned off');
    byId(root, 'inside').click();
    expect(clicks).toBe(1);
    release();
  });

  test('the stylesheet dims exactly the controls the selector holds', async () => {
    const css = await Bun.file(new URL('../../styles/foundation.css', import.meta.url)).text();
    const rule = css.slice(css.indexOf("body:has(.weft-shell[data-connection='unreachable'])"));
    const dimmed = rule.slice(0, rule.indexOf('{')).replaceAll(/\s+/g, ' ').replaceAll('"', "'");
    for (const part of CHANGING_ACTION_SELECTOR.split(', ')) {
      expect(dimmed).toContain(part.replaceAll('"', "'"));
    }
  });

  test('names the selector it matches', () => {
    expect(CHANGING_ACTION_SELECTOR).toContain('[data-changes]');
  });
});
