import { afterEach, describe, expect, test } from 'bun:test';

import { resetScrollLock } from '../../src/_internal/overlay.ts';
import ButtonGroup from '../../src/components/button-group/index.ts';
import Button from '../../src/components/button/index.ts';
import Card from '../../src/components/card/index.ts';
import Modal from '../../src/components/modal/index.ts';
import { installModalDialogStubs } from '../../src/components/modal/modal-test-helpers.ts';
import { contextsFor } from './bundle-host.ts';
import {
  type CinderComponent,
  createCinderGlobal,
  lazyComponent,
  type MountedCinder,
} from './bundle-runtime.svelte.ts';

installModalDialogStubs();

const mounted: MountedCinder[] = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.destroy();
  document.body.replaceChildren();
  resetScrollLock();
});

function target(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

function track(instance: MountedCinder): MountedCinder {
  mounted.push(instance);
  return instance;
}

describe('createCinderGlobal', () => {
  test('exposes a React component per export name, in order', () => {
    const cinder = createCinderGlobal({ Button, Card, Modal });
    expect(cinder.componentNames).toEqual(['Button', 'Card', 'Modal']);
    for (const name of cinder.componentNames) {
      expect(typeof cinder[name]).toBe('function');
      expect((cinder[name] as { displayName?: string }).displayName).toBe(`Cinder.${name}`);
    }
  });

  test('refuses an export the module does not have and a reserved name', () => {
    expect(() => createCinderGlobal({ Button: undefined })).toThrow('no component export Button');
    expect(() => createCinderGlobal({ mount: Button })).toThrow('cannot expose');
    const cinder = createCinderGlobal({ Button });
    expect(() => cinder.mount('Missing', target())).toThrow('no component Missing');
  });
});

describe('Cinder.mount', () => {
  test('mounts Button with props and text children', () => {
    const cinder = createCinderGlobal({ Button });
    const element = target();
    track(cinder.mount('Button', element, { variant: 'primary' }, 'Process inbox'));
    expect(element.querySelector('button')?.textContent).toContain('Process inbox');
  });

  test('mounts Card with its title and a DOM node as children', () => {
    const cinder = createCinderGlobal({ Card });
    const element = target();
    const body = document.createElement('p');
    body.textContent = 'Three items to process';
    track(cinder.mount('Card', element, { title: 'Inbox' }, body));
    expect(element.textContent).toContain('Inbox');
    expect(element.contains(body)).toBe(true);
  });

  test('mounts an open Modal with its title and children', () => {
    const cinder = createCinderGlobal({ Modal });
    track(cinder.mount('Modal', target(), { open: true, title: 'Rename list' }, 'Modal body'));
    const dialog = document.body.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Rename list');
    expect(dialog?.textContent).toContain('Modal body');
  });

  test('updates props in place, keeping the mounted element', () => {
    const cinder = createCinderGlobal({ Button });
    const element = target();
    const instance = track(cinder.mount('Button', element, { label: 'Save' }));
    const button = element.querySelector('button');
    expect(button?.textContent).toContain('Save');
    instance.update({ label: 'Saved' });
    expect(element.querySelector('button')).toBe(button);
    expect(button?.textContent).toContain('Saved');
  });

  test('a component mounted into another one’s children joins its context', () => {
    const cinder = createCinderGlobal({ Button, Card });
    const element = target();
    const hosts: HTMLElement[] = [];
    track(
      cinder.mount('Card', element, { title: 'Inbox' }, (host) => {
        hosts.push(host);
      }),
    );
    const [host] = hosts;
    if (host === undefined) throw new Error('Card rendered no children host');
    expect(host.dataset['cinderChildren']).toBe('');
    const slot = document.createElement('div');
    host.append(slot);
    expect(contextsFor(slot)).toBeInstanceOf(Map);
    track(cinder.mount('Button', slot, { label: 'Process inbox' }));
    expect(element.querySelector('button')?.textContent).toContain('Process inbox');
  });

  test('a Button mounted inside a ButtonGroup reads the group’s context', () => {
    const cinder = createCinderGlobal({ Button, ButtonGroup });
    const element = target();
    const hosts: HTMLElement[] = [];
    track(
      cinder.mount('ButtonGroup', element, { label: 'List actions' }, (host) => {
        hosts.push(host);
      }),
    );
    const [host] = hosts;
    if (host === undefined) throw new Error('ButtonGroup rendered no children host');
    // The slot keeps the Button off the group's direct children, which the group tags itself,
    // so only the context Button reads at initialization can set the attribute.
    const slot = document.createElement('div');
    host.append(slot);
    track(cinder.mount('Button', slot, { label: 'Archive' }));
    const button = slot.querySelector('button');
    expect(button?.getAttribute('data-cinder-button-group-item')).toBeTruthy();

    const standalone = target();
    track(cinder.mount('Button', standalone, { label: 'Archive' }));
    expect(standalone.querySelector('button')?.hasAttribute('data-cinder-button-group-item')).toBe(
      false,
    );
  });
});

describe('lazy components', () => {
  test('load once, on the first mount, and mount with the latest props', async () => {
    let finishLoading: (component: CinderComponent) => void = () => undefined;
    const loading = new Promise<CinderComponent>((resolve) => {
      finishLoading = resolve;
    });
    let loads = 0;
    const cinder = createCinderGlobal({
      Button: lazyComponent(() => {
        loads += 1;
        return loading;
      }),
    });
    expect(loads).toBe(0);
    const element = target();
    const instance = track(cinder.mount('Button', element, { label: 'Save' }));
    instance.update({ label: 'Saved' });
    const destroyed = target();
    cinder.mount('Button', destroyed, { label: 'Never' }).destroy();
    expect(element.querySelector('button')).toBeNull();
    expect(loads).toBe(1);

    finishLoading(Button as unknown as CinderComponent);
    await loading;
    expect(element.querySelector('button')?.textContent).toContain('Saved');
    expect(destroyed.querySelector('button')).toBeNull();
  });
});
