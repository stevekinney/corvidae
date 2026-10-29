import { describe, expect, it } from 'bun:test';

import { WebExtensionStorage } from './web-extension.ts';

type ChangeListener = (changes: Record<string, unknown>, areaName: string) => void;

function createNamespace() {
  const added: ChangeListener[] = [];
  const removed: ChangeListener[] = [];
  const area = {
    get: () => Promise.resolve({}),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  const namespace = {
    storage: {
      local: area,
      onChanged: {
        addListener(listener: ChangeListener) {
          added.push(listener);
        },
        removeListener(listener: ChangeListener) {
          removed.push(listener);
        },
      },
    },
  };
  return { added, namespace, removed };
}

describe('WebExtensionStorage change listener', () => {
  it('registers one listener that ignores changes, and removes that same listener on dispose', () => {
    const { added, namespace, removed } = createNamespace();
    const storage = new WebExtensionStorage({ area: 'local' }, namespace);

    expect(added).toHaveLength(1);
    const [listener] = added;
    expect(listener!({ somewhere: { newValue: 1 } }, 'local')).toBeUndefined();

    storage[Symbol.dispose]();
    expect(removed).toEqual([listener!]);
  });
});
