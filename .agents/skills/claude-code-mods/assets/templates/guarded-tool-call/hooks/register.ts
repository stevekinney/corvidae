import type { EngineInterface, Register } from 'claude-code';

import { outcomeOf, protectedReason, riskOf } from './policy';

const CONFIRM = 'Run it';
const REFUSE = 'Refuse';

/**
 * Where a path lands with every link followed, or `undefined` when nothing is
 * there yet (a new file). A rejection propagates on purpose: the guard that
 * awaits this fails, and its `.catch` refuses the call.
 *
 * Declared at the top level of this file, which is where static analysis
 * follows `$` into a helper.
 */
async function realPathOf($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await $.fs.exists(path))) return undefined;
  const stat = await $.fs.stat(path, { resolve: true });
  return stat.realPath;
}

export const register: Register = (on) => {
  // Registered first, so it is outermost in this module's chain: it sees the
  // final outcome, including refusals from the guards below. It fails open:
  // a reporting problem never changes what Claude reads, and it never calls
  // `next` twice, so the tool never runs again because reporting failed.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    try {
      $.ui.log(`audit ${e.tool}: ${outcomeOf(result)}`, { to: 'debug' });
    } catch {
      // Reporting is optional; the call's result stands either way.
    }
    return result;
  });

  // A guard: it judges before it calls `next`, so its `.catch` can refuse
  // safely. If the check throws or runs out of time before `next`, the write
  // does not run. If it fails after `next`, the tool already ran, and the
  // handler replays that result instead of running the tool a second time.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path;
    const reason = protectedReason(path, await realPathOf($, path));
    if (reason === undefined) return next(e);
    return {
      deny: `${$.plugin.name}: ${path} was not changed because ${reason}. Ask the user to make this change themselves.`,
    };
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `${$.plugin.name}: the protected-path check failed (${next.error.kind}), so this edit did not run. Tell the user rather than retrying.`,
        },
  );

  // A hold: the call waits inside `$.ui.ask`, a mods API call, so the wait
  // does not count against this hook's time limit. Every answer except the
  // explicit confirmation refuses, including a dismissed question and a
  // session with nobody to ask, such as `claude -p`.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const risk = riskOf(e.command);
    if (risk === undefined) return next(e);
    let answer = REFUSE;
    try {
      answer = await $.ui.ask(`Claude wants to run a ${risk}: ${e.command}`, {
        options: [CONFIRM, REFUSE],
        header: 'Confirm',
      });
    } catch {
      // Dismissed, "Chat about this", or no person to ask: keep the refusal.
    }
    if (answer !== CONFIRM) {
      return {
        deny: `${$.plugin.name}: the user did not confirm this ${risk}, so it did not run. Ask the user how to proceed instead of retrying.`,
      };
    }
    return next(e);
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          deny: `${$.plugin.name}: the confirmation for this command failed (${next.error.kind}), so it did not run.`,
        },
  );
};
