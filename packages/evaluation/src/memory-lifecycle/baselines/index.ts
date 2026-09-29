import type { BaselineOptions, MemoryBaselineAdapter, MemoryBaselineName } from './adapter';
import { createFlatHybridBaseline } from './flat-hybrid';
import { createLifecycleBaseline } from './lifecycle';
import { createNoMemoryBaseline } from './no-memory';
import { createRawLogSearchBaseline } from './raw-log-search';

/** A fresh instance of the named baseline. */
export function createBaselineAdapter(
  name: MemoryBaselineName,
  options: BaselineOptions,
): MemoryBaselineAdapter {
  switch (name) {
    case 'no-memory':
      return createNoMemoryBaseline();
    case 'raw-log-search':
      return createRawLogSearchBaseline(options);
    case 'flat-hybrid':
      return createFlatHybridBaseline(options);
    case 'lifecycle':
      return createLifecycleBaseline(options);
  }
}
