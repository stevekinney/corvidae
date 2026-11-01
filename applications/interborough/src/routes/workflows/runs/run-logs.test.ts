import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { RUN_LOG_CASES, linesOf } from './run-log-cases.test-support.ts';
import type { RunLogLine } from './run-logs-data.ts';
import RunLogsHarness from './run-logs.test-harness.svelte';

function line(sequence: number, message: string): RunLogLine {
  return {
    sequence,
    step: sequence,
    level: 'info',
    message,
    timestamp: 1_000 + sequence,
    workflowType: 'work',
    truncated: false,
  };
}

function client(result: () => Promise<{ lines: RunLogLine[]; dropped: number }>) {
  return { operations: { 'weft.workflows.logs.list': result } };
}

describe('RunLogs', () => {
  test('is closed until asked for, then lists every line the run logged, oldest first', async () => {
    const { getByRole, getAllByRole, queryByRole } = render(RunLogsHarness, {
      props: {
        workflowId: 'run-1',
        client: client(async () => ({ lines: [line(0, 'first'), line(1, 'second')], dropped: 0 })),
      },
    });
    const trigger = await waitFor(() => getByRole('button', { name: /Logs · 2 lines/ }));
    expect(queryByRole('list', { name: 'Log lines' })).toBeNull();
    await fireEvent.click(trigger);
    const items = await waitFor(() => getAllByRole('listitem'));
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
    ]);
  });

  for (const runCase of RUN_LOG_CASES) {
    test(`keeps the whole log of ${runCase.name} in the rail, whatever the steps took`, async () => {
      const { getByRole, getAllByRole } = render(RunLogsHarness, {
        props: {
          workflowId: 'run-1',
          client: client(async () => ({ lines: linesOf(runCase), dropped: 0 })),
        },
      });
      await fireEvent.click(await waitFor(() => getByRole('button', { name: /Logs/ })));
      const items = await waitFor(() => getAllByRole('listitem'));
      expect(items.map((item) => item.textContent)).toEqual(
        runCase.lines.map(([message]) => expect.stringContaining(message)),
      );
    });
  }

  test('says how many older lines were removed', async () => {
    const { getByRole, findByText } = render(RunLogsHarness, {
      props: {
        workflowId: 'run-1',
        client: client(async () => ({ lines: [line(0, 'kept')], dropped: 12 })),
      },
    });
    await fireEvent.click(await waitFor(() => getByRole('button', { name: /Logs/ })));
    expect(
      await findByText('12 older lines were removed to stay within the limit.'),
    ).not.toBeNull();
  });

  test('shows an empty state for a run that logged nothing', async () => {
    const { getByRole, findByText } = render(RunLogsHarness, {
      props: { workflowId: 'run-1', client: client(async () => ({ lines: [], dropped: 0 })) },
    });
    await fireEvent.click(await waitFor(() => getByRole('button', { name: /Logs/ })));
    expect(await findByText('Nothing was logged')).not.toBeNull();
  });

  test('shows an error state with a way to try again when the lines cannot be read', async () => {
    let attempts = 0;
    const { getByRole, findByText, findByRole } = render(RunLogsHarness, {
      props: {
        workflowId: 'run-1',
        client: client(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('storage is unavailable');
          return { lines: [line(0, 'recovered')], dropped: 0 };
        }),
      },
    });
    await fireEvent.click(await waitFor(() => getByRole('button', { name: /Logs/ })));
    expect(await findByText('The logs could not be read')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    expect(await findByText('recovered')).not.toBeNull();
  });

  test('draws nothing for an engine that does not offer log lines', async () => {
    const { container } = render(RunLogsHarness, {
      props: { workflowId: 'run-1', client: { operations: {} } },
    });
    expect(container.querySelector('[data-section="logs"]')).toBeNull();
  });
});
