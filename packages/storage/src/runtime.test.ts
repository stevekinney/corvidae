import { afterEach, describe, expect, it } from 'bun:test';
import * as nodeFileSystem from 'node:fs';

import {
  getProcess,
  setStorageRuntimeTestOverridesForTesting,
  tryLoadNodeBuiltin,
} from './runtime.ts';

afterEach(() => {
  setStorageRuntimeTestOverridesForTesting();
});

describe('storage runtime loader', () => {
  it('reads the real process global when no override is set', () => {
    expect(getProcess()).toBe(globalThis.process);
  });

  it('loads a built-in through process.getBuiltinModule', () => {
    expect(tryLoadNodeBuiltin('node:fs')?.existsSync).toBe(nodeFileSystem.existsSync);
  });

  it('returns the overriding process, even an undefined one', () => {
    setStorageRuntimeTestOverridesForTesting({ process: undefined });
    expect(getProcess()).toBeUndefined();
    expect(tryLoadNodeBuiltin('node:fs')).toBeUndefined();
  });

  it('returns undefined from the built-in loader when process.getBuiltinModule is missing', () => {
    const processStub = { versions: { node: '22.5.0' } } as typeof globalThis.process;
    setStorageRuntimeTestOverridesForTesting({ process: processStub });
    expect(getProcess()).toBe(processStub);
    expect(tryLoadNodeBuiltin('node:zlib')).toBeUndefined();
  });

  it('loads through the overriding process when it provides getBuiltinModule', () => {
    const loaded: string[] = [];
    const processStub = {
      getBuiltinModule: (id: string) => {
        loaded.push(id);
        return { marker: id };
      },
    } as unknown as typeof globalThis.process;
    setStorageRuntimeTestOverridesForTesting({ process: processStub });
    expect(tryLoadNodeBuiltin('node:module')).toEqual({ marker: 'node:module' } as never);
    expect(loaded).toEqual(['node:module']);
  });
});
