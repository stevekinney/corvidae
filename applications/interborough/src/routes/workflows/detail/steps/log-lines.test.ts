import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import LogLines from './log-lines.svelte';
import type { RunLogLine } from './step-logs.ts';

function line(overrides: Partial<RunLogLine>): RunLogLine {
  return {
    sequence: 0,
    step: 0,
    level: 'info',
    message: 'hello',
    timestamp: Date.UTC(2026, 9, 31, 12, 0, 0, 7),
    workflowType: 'work',
    truncated: false,
    ...overrides,
  };
}

describe('LogLines', () => {
  test('lists each line in order with its level, its message and the details it carried', () => {
    const { getByRole, getAllByRole } = render(LogLines, {
      props: {
        label: 'Log lines',
        lines: [
          line({ sequence: 0, message: 'run started', attributes: { order: 'ord_1' } }),
          line({ sequence: 1, level: 'error', message: 'it broke' }),
        ],
      },
    });
    expect(getByRole('list', { name: 'Log lines' })).not.toBeNull();
    const items = getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('run started');
    expect(items[0]?.textContent).toContain('info');
    expect(items[0]?.textContent).toContain('{"order":"ord_1"}');
    expect(items[1]?.getAttribute('data-level')).toBe('error');
    expect(items[1]?.textContent).toContain('it broke');
  });

  test('gives each line a machine-readable time and leaves out empty details', () => {
    const { container } = render(LogLines, {
      props: { label: 'Log lines', lines: [line({ attributes: {} })] },
    });
    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-10-31T12:00:00.007Z');
    expect(container.querySelector('.ib-log-lines__attributes')).toBeNull();
  });
});
