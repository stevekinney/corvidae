import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { type Runner, UsageError } from './process-runner.ts';

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const decisionSchema = z.strictObject({
  decision: z.literal('dispatch'),
  ref: z.string().min(1),
  head: commit,
  planDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reviewReference: z.string().trim().min(1),
  decidedAt: z.iso.datetime(),
});

type Decision = z.infer<typeof decisionSchema>;

function readDecision(path: string): Decision {
  try {
    return decisionSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new UsageError(`No valid coordinator decision at ${path}.`);
  }
}

function planDigest(command: string[]): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

/** Records a coordinator approval for this exact local plan, or validates one before dispatch. */
export function bindCandidateDispatch(options: {
  runner: Runner;
  command: string[];
  ref: string;
  head: string;
  approvalPath: string | undefined;
  decisionPath: string | undefined;
  expectedHead: string | undefined;
  reviewReference: string | undefined;
  requiredCheck: string | undefined;
}): string[] {
  const {
    runner,
    command,
    ref,
    head,
    approvalPath,
    decisionPath,
    expectedHead,
    reviewReference,
    requiredCheck,
  } = options;
  if (!commit.safeParse(head).success)
    throw new UsageError('The local candidate must be a full commit SHA.');
  if (approvalPath !== undefined) {
    if (
      decisionPath !== undefined ||
      requiredCheck !== undefined ||
      expectedHead !== head ||
      !reviewReference?.trim()
    )
      throw new UsageError(
        '--approve needs the exact local --head and a --review-ref, and records a decision without dispatching.',
      );
    const approval: Decision = {
      decision: 'dispatch',
      ref,
      head,
      planDigest: planDigest(command),
      reviewReference: reviewReference.trim(),
      decidedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(approvalPath, JSON.stringify(approval, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      throw new UsageError(
        `Could not create the coordinator decision at ${approvalPath}. Use a new path.`,
      );
    }
    return command;
  }
  if (requiredCheck !== undefined) {
    if (decisionPath !== undefined || expectedHead !== head || !/^COR-\d+:\S+$/.test(requiredCheck))
      throw new UsageError(
        '--required-check needs COR-<number>:<criterion> and the exact local --head.',
      );
  } else {
    if (decisionPath === undefined)
      throw new UsageError(
        'Discretionary CI needs a coordinator decision for this candidate. Use --dry-run to plan.',
      );
    const decision = readDecision(decisionPath);
    if (
      decision.ref !== ref ||
      decision.head !== head ||
      decision.planDigest !== planDigest(command)
    )
      throw new UsageError(
        'The coordinator decision is for a different branch, revision or dispatch plan.',
      );
  }
  const remoteRef = `refs/heads/${ref}`;
  const remote = runner(['git', 'ls-remote', '--exit-code', 'origin', remoteRef]);
  if (remote.code !== 0 || remote.stdout.trim() !== `${head}\t${remoteRef}`)
    throw new UsageError(
      `The remote branch ${ref} is unavailable or has moved from the reviewed revision ${head}.`,
    );
  if (decisionPath !== undefined) {
    try {
      writeFileSync(`${decisionPath}.attempt`, new Date().toISOString() + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      throw new UsageError(
        `Cannot reserve a dispatch for ${decisionPath}. Check GitHub for an existing attempt before approving another run.`,
      );
    }
  }
  return [...command, '-f', `chef_candidate=${head}`];
}
