import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolbox } from '../src';

// COR-2374: Bun collects an `AbortSignal.any` signal that only an event listener's `signal` option
// refers to, and aborting its sources then never removes that listener. A listener added with a
// caller's signal kept receiving events after the caller aborted once a collection ran in between,
// which a loaded CI host does at its own time; `Bun.gc(true)` forces it here.
function createEventTool() {
  return createTool({
    name: 'listener-lifetime',
    description: 'listener lifetime',
    input: z.object({}),
    async execute() {
      return 'ok';
    },
  });
}

describe('tool listeners after a garbage collection', () => {
  it('stop when the caller aborts', () => {
    const tool = createEventTool();
    const caller = new AbortController();
    let received = 0;
    tool.addEventListener(
      'ping' as never,
      () => {
        received += 1;
      },
      { signal: caller.signal },
    );
    Bun.gc(true);
    caller.abort();
    tool.dispatchEvent(new Event('ping'));
    expect(received).toBe(0);
  });

  it('stop when the returned remover runs', () => {
    const tool = createEventTool();
    const caller = new AbortController();
    let received = 0;
    const remove = tool.addEventListener(
      'ping' as never,
      () => {
        received += 1;
      },
      { signal: caller.signal },
    );
    Bun.gc(true);
    remove();
    tool.dispatchEvent(new Event('ping'));
    expect(received).toBe(0);
  });

  it('still hear events while neither signal has aborted', () => {
    const tool = createEventTool();
    const caller = new AbortController();
    let received = 0;
    tool.addEventListener(
      'ping' as never,
      () => {
        received += 1;
      },
      { signal: caller.signal },
    );
    Bun.gc(true);
    tool.dispatchEvent(new Event('ping'));
    expect(received).toBe(1);
  });

  it('are not added when the caller signal has already aborted', () => {
    const tool = createEventTool();
    let received = 0;
    tool.addEventListener(
      'ping' as never,
      () => {
        received += 1;
      },
      { signal: AbortSignal.abort() },
    );
    tool.dispatchEvent(new Event('ping'));
    expect(received).toBe(0);
  });
});

describe('toolbox listeners after a garbage collection', () => {
  it('stop when the caller aborts', () => {
    const toolbox = createToolbox([]);
    const caller = new AbortController();
    let received = 0;
    toolbox.addEventListener(
      'ping' as never,
      () => {
        received += 1;
      },
      { signal: caller.signal },
    );
    Bun.gc(true);
    caller.abort();
    toolbox.dispatchEvent(new Event('ping'));
    expect(received).toBe(0);
  });

  it('stop when the returned remover runs', () => {
    const toolbox = createToolbox([]);
    const caller = new AbortController();
    let received = 0;
    const remove = toolbox.addEventListener(
      'ping' as never,
      () => {
        received += 1;
      },
      { signal: caller.signal },
    );
    Bun.gc(true);
    remove();
    toolbox.dispatchEvent(new Event('ping'));
    expect(received).toBe(0);
  });
});
