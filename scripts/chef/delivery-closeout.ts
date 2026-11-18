import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeliverDependencies, DeliverOptions, DeliverReport } from './deliver.ts';
import {
  collectCompletionRecords,
  renderMemberCompletion,
  type CompletionRecord,
} from './delivery-completion.ts';
import {
  isDeliveryMergeObservation,
  validateDeliveryApproval,
  validateDeliveryMergeObservation,
  type LoadedDeliveryVerification,
} from './delivery-verification.ts';
import {
  readExecutionSnapshot,
  requireAuthority,
  updateDeliveryCloseout,
  withProviderTransitionLock,
  type DeliveryCloseout,
} from './execution-state.ts';
import {
  fetchComments,
  fetchIssue,
  normalizeMarkdown,
  postComment,
  setState,
  updateComment,
  type LinearClient,
} from './linear.ts';
import { digest } from './verification-plan.ts';

/** Reconcile a deterministic comment marker before creating or updating the completion report. */
async function completeMember(
  record: CompletionRecord,
  mergeCommit: string,
  client: LinearClient,
  closeout: DeliveryCloseout,
  save: () => Promise<void>,
): Promise<void> {
  const key = record.identifier;
  const progress = (Object.hasOwn(closeout.members, key) ? closeout.members[key] : undefined) ?? {
    commentIntent: false,
    closed: false,
  };
  closeout.members[key] = progress;
  if (progress.closed) return;
  const marker = `<!-- chef-completion:${record.operationId}:${key} -->`;
  const body = `${renderMemberCompletion(record, mergeCommit)}\n\n${marker}\n`;
  const bodyDigest = digest(normalizeMarkdown(body));
  const before = await fetchComments(client, key);
  const matching = before.filter((comment) => comment.body.includes(marker));
  if (matching.length > 1)
    throw new Error(`${key}: completion marker has multiple provider comments`);
  const existing = matching[0];
  if (existing === undefined && progress.commentIntent)
    throw new Error(
      `${key}: prior comment outcome is unknown; provider marker is not yet observable`,
    );
  if (existing === undefined || digest(normalizeMarkdown(existing.body)) !== bodyDigest) {
    // Save intent before the write; a lost response is recovered by its paginated provider marker.
    progress.commentIntent = true;
    await save();
    const result =
      existing === undefined
        ? await postComment(client, key, body)
        : await updateComment(client, key, existing.id, body);
    if (!result.ok) {
      if (existing === undefined && result.data['mutationSucceeded'] === false) {
        progress.commentIntent = false;
        await save();
      }
      throw new Error(result.summary);
    }
    const after = await fetchComments(client, key);
    const comments = after.filter((comment) => comment.body.includes(marker));
    if (comments.length !== 1 || digest(normalizeMarkdown(comments[0]!.body)) !== bodyDigest)
      throw new Error(`${key}: completion comment read-back does not match`);
    progress.commentId = comments[0]!.id;
  } else progress.commentId = existing.id;
  progress.commentIntent = false;
  progress.bodyDigest = bodyDigest;
  await save();
  if (!record.requestedClose || !record.eligible) return;
  const issue = await fetchIssue(client, key);
  if (issue.state.name !== 'Done') {
    const result = await setState(client, key, 'Done');
    if (!result.ok) throw new Error(result.summary);
  }
  const after = await fetchIssue(client, key);
  if (after.state.name !== 'Done')
    throw new Error(`${key}: completion state read-back is ${after.state.name}`);
  progress.closed = true;
  await save();
}

/** Continue only unfinished effects, fenced by the original dispatch authority throughout. */
export async function closeDelivery(
  verification: LoadedDeliveryVerification,
  options: DeliverOptions,
  report: DeliverReport,
  dependencies: Partial<DeliverDependencies>,
): Promise<DeliverReport> {
  const { request, state } = verification;
  return withProviderTransitionLock(state, request.authority.resource, async () => {
    requireAuthority(state, request.authority);
    const problem = validateDeliveryApproval(
      verification,
      { route: options.branch === undefined ? 'pull-request' : 'branch', action: 'merge' },
      dependencies.verification,
    );
    if (problem !== undefined) throw new Error(problem);
    const operation = readExecutionSnapshot(state).operations[request.operationId];
    if (operation?.outcome !== 'observed' || report.mergeCommit === null)
      throw new Error('delivery closeout requires an observed original merge');
    if (
      !isDeliveryMergeObservation(operation.observed) ||
      operation.observed.state !== 'confirmed-merge' ||
      operation.observed.mergeCommit !== report.mergeCommit ||
      operation.observed.branch !== options.branch ||
      operation.observed.pullRequest !== options.pr
    )
      throw new Error('delivery closeout has mismatched original provider observation');
    validateDeliveryMergeObservation(operation.observed, request);

    if (resolve(options.worktree) !== resolve(request.worktree))
      throw new Error('delivery worktree differs from the coordinator-approved ownership');
    const closeout: DeliveryCloseout = operation.closeout ?? {
      ledger: false,
      members: Object.create(null),
      complete: false,
    };
    const save = () =>
      updateDeliveryCloseout(state, request.authority, request.operationId, closeout);
    const fail = (step: string, error: unknown) => {
      report.failedStep = step;
      report.detail = error instanceof Error ? error.message : String(error);
      return report;
    };
    if (!closeout.ledger) {
      try {
        if (dependencies.record === undefined)
          throw new Error('no delivery ledger writer was provided');
        dependencies.record({
          operationId: request.operationId,
          pr: options.pr,
          branch: options.branch,
          head: request.revision,
          mergeCommit: report.mergeCommit,
        });
        closeout.ledger = true;
        await save();
      } catch (error) {
        return fail('ledger', error);
      }
    }
    const records = collectCompletionRecords(
      request,
      'completion',
      dependencies.verification?.transport,
    );
    for (const record of records) {
      if (!record.track) continue;
      try {
        if (dependencies.client === undefined) throw new Error('no Linear client was provided');
        await completeMember(record, report.mergeCommit, dependencies.client, closeout, save);
        if (
          Object.hasOwn(closeout.members, record.identifier) &&
          closeout.members[record.identifier]?.closed
        )
          report.issues.push({ identifier: record.identifier, state: 'Done' });
        else report.leftOpen.push(record.identifier);
      } catch (error) {
        return fail('issue', error);
      }
    }
    if (closeout.worktree?.removed === true) report.worktree = closeout.worktree;
    else if (options.keepWorktree === true) {
      report.worktree = { removed: false, detail: 'kept by --keep-worktree' };
      closeout.worktree = report.worktree;
      await save();
    } else {
      try {
        if (dependencies.remove === undefined) throw new Error('no worktree remover was provided');
        if (existsSync(request.worktree)) {
          const removed = dependencies.remove({
            configPath: options.configPath,
            name: request.worktree,
            keepRemote: false,
            deliveredTip: request.revision,
            endProcesses: true,
          });
          report.worktree = { removed: true, detail: removed.path };
        } else report.worktree = { removed: true, detail: `${request.worktree} already absent` };
        closeout.worktree = report.worktree;
        await save();
      } catch (error) {
        return fail('worktree', error);
      }
    }
    closeout.complete = records.every(
      (record) =>
        !record.track || !record.requestedClose || closeout.members[record.identifier]?.closed,
    );
    await save();
    return report;
  });
}
