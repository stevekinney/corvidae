import type { Register } from 'claude-code';

import { countOutcome, countRequested, describeTally, emptyTally, outcomeOf } from './tally';

// Module state: disposable. Every hot reload runs this file again and starts
// the count over; keep anything that must survive a reload in `$.state`, and
// anything that must survive the session in `$.store`.
let toolCallTally = emptyTally;

export const register: Register = (on) => {
  // Runs once before the first prompt and again after each reload of this
  // module, so registration here must be safe to repeat.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'tool-tally',
        description:
          'Show how many tool calls succeeded, failed, or were refused since this mod loaded',
      });
    } catch (error) {
      // A taken command name throws. Keep the session going and say why in
      // the debug log rather than failing the whole hook.
      $.ui.log(`/tool-tally was not registered: ${String(error)}`, { to: 'debug' });
    }
    return next(e);
  });

  // Observes every tool call without changing it. The count of requests
  // happens before `next`; the outcome is only known after it resolves,
  // because calling a tool is not proof that it ran or succeeded.
  on('tool.call', async ($, e, next) => {
    toolCallTally = countRequested(toolCallTally);
    const result = await next(e);
    toolCallTally = countOutcome(toolCallTally, outcomeOf(result));
    return result;
  });

  // Answers its own command; there is no engine behavior beneath it to run.
  on('command.run', { command: 'tool-tally' }, () => ({ text: describeTally(toolCallTally) }));
};
