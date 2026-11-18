import { describe as bunDescribe, test as bunTest, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import {
  loadDeliveryVerification,
  recordDeliveryMergeObservation,
} from './delivery-verification.ts';
import { directMerge, type DirectMergeOptions } from './direct-merge.ts';
import { cancelDispatch, readExecutionSnapshot } from './execution-state.ts';
import { mergeGate, type MergeGateOptions } from './merge-gate.ts';
import { type Runner } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';

const commit = 'd'.repeat(40);

function runner(
  request: { revision: string; base: string; integrationTree: string },
  calls: string[][],
): Runner {
  return (command) => {
    calls.push(command);
    if (
      command[0] === 'git' &&
      command[1] === 'rev-parse' &&
      command[2] === '--path-format=absolute'
    )
      return { code: 0, stdout: `${tmpdir()}\n`, stderr: '' };
    if (command[0] === 'git' && command[1] === 'fetch') return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'git' && command[1] === 'merge-tree')
      return { code: 0, stdout: `${request.integrationTree}\n`, stderr: '' };
    if (command[0] === 'git' && command[1] === 'rev-parse')
      return { code: 0, stdout: `${request.integrationTree}\n`, stderr: '' };
    if (command[0] === 'gh' && command[1] === 'pr' && command[2] === 'view')
      return {
        code: 0,
        stdout: JSON.stringify({
          state: 'MERGED',
          headRefOid: request.revision,
          mergeCommit: { oid: commit },
        }),
        stderr: '',
      };
    return { code: 0, stdout: '', stderr: '' };
  };
}

const scenarios = createScenarios({}, { test: bunTest, describe: bunDescribe });

scenarios.describe('delivery merge recovery', () => {
  scenarios.scenario(
    'inspects a lost PR response and never issues a second merge mutation',
    async () => {
      const fixture = await createDeliveryVerificationFixture(undefined, { route: 'pull-request' });
      const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
      const configPath = join(directory, 'config.json');
      const commentFile = join(directory, 'comment.md');
      writeFileSync(
        configPath,
        JSON.stringify({
          repository: fixture.request.repository,
          defaultBranch: 'main',
          worktreeRoots: { codex: directory, claude: directory },
          manifestName: 'fixture',
          installCommand: 'true',
          gateCommand: 'true',
          affectedCheckCommand: 'true',
          mergeMethod: 'squash',
        }),
      );
      writeFileSync(commentFile, 'confirmed');
      await recordDeliveryMergeObservation(
        loadDeliveryVerification(fixture.verification, fixture.dependencies),
        {
          route: 'pull-request',
          pullRequest: 1,
          reviewedHead: fixture.request.revision,
          base: fixture.request.base,
          integrationTree: fixture.request.integrationTree,
          state: 'pending-provider-outcome',
        },
        'unknown',
        { state: fixture.state },
      );
      const calls: string[][] = [];
      const options: MergeGateOptions = {
        configPath,
        pr: 1,
        worktree: fixture.directory,
        commentFile,
        dryRun: false,
        verification: fixture.verification,
      };
      const report = await mergeGate(options, {
        runner: runner(fixture.request, calls),
        verification: fixture.dependencies,
      });
      expect(report).toMatchObject({ merged: true, mergeCommit: commit, failedStep: null });
      expect(calls.some((call) => call[0] === 'gh' && call[2] === 'merge')).toBe(false);
    },
  );

  scenarios.scenario('refuses recovery after the original authority is cancelled', async () => {
    const fixture = await createDeliveryVerificationFixture(undefined, { route: 'pull-request' });
    const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
    const configPath = join(directory, 'config.json');
    const commentFile = join(directory, 'comment.md');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: fixture.request.repository,
        defaultBranch: 'main',
        worktreeRoots: { codex: directory, claude: directory },
        manifestName: 'fixture',
        installCommand: 'true',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    writeFileSync(commentFile, 'confirmed');
    await recordDeliveryMergeObservation(
      loadDeliveryVerification(fixture.verification, fixture.dependencies),
      {
        route: 'pull-request',
        pullRequest: 1,
        reviewedHead: fixture.request.revision,
        base: fixture.request.base,
        integrationTree: fixture.request.integrationTree,
        state: 'pending-provider-outcome',
      },
      'unknown',
      { state: fixture.state },
    );
    await cancelDispatch(fixture.state, fixture.request.authority);
    const calls: string[][] = [];
    expect(
      await throwingRejectionOf(
        mergeGate(
          {
            configPath,
            pr: 1,
            worktree: fixture.directory,
            commentFile,
            dryRun: false,
            verification: fixture.verification,
          },
          { runner: runner(fixture.request, calls), verification: fixture.dependencies },
        ),
      ),
    ).toThrow('revoked');
    expect(calls.some((call) => call[0] === 'gh' && call[2] === 'merge')).toBe(false);
  });
});

scenarios.scenario('resumes only branch deletion after a confirmed direct merge', async () => {
  const fixture = await createDeliveryVerificationFixture(undefined, { route: 'branch' });
  const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
  const configPath = join(directory, 'config.json');
  const messageFile = join(directory, 'message.txt');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: fixture.request.repository,
      defaultBranch: 'main',
      worktreeRoots: { codex: directory, claude: directory },
      manifestName: 'fixture',
      installCommand: 'true',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  writeFileSync(messageFile, 'merge');
  await recordDeliveryMergeObservation(
    loadDeliveryVerification(fixture.verification, fixture.dependencies),
    {
      route: 'branch',
      branch: 'topic',
      reviewedHead: fixture.request.revision,
      base: fixture.request.base,
      integrationTree: fixture.request.integrationTree,
      mergeCommit: commit,
      state: 'confirmed-merge',
    },
    'observed',
    { state: fixture.state },
  );
  const calls: string[][] = [];
  const raw: Runner = (command) => {
    calls.push(command);
    if (
      command[0] === 'git' &&
      command[1] === 'rev-parse' &&
      command[2] === '--path-format=absolute'
    )
      return { code: 0, stdout: `${tmpdir()}\n`, stderr: '' };
    if (command[0] === 'git' && command[1] === 'fetch') return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'git' && command[1] === 'merge-base')
      return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'git' && command[1] === 'rev-parse')
      return {
        code: 0,
        stdout:
          command[2] === `${commit}^`
            ? `${fixture.request.base}\n`
            : `${fixture.request.integrationTree}\n`,
        stderr: '',
      };
    if (command[0] === 'git' && command[1] === 'push') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const options: DirectMergeOptions = {
    configPath,
    branch: 'topic',
    head: fixture.request.revision,
    messageFile,
    worktree: fixture.directory,
    verification: fixture.verification,
  };
  const report = await directMerge(options, { runner: raw, verification: fixture.dependencies });
  expect(report).toMatchObject({ merged: true, mergeCommit: commit, failedStep: null });
  expect(calls.filter((call) => call[0] === 'git' && call[1] === 'push')).toEqual([
    ['git', 'push', 'origin', '--delete', 'topic'],
  ]);
});

scenarios.scenario(
  'keeps failed deletion unresolved when its provider readback is unavailable',
  async () => {
    const fixture = await createDeliveryVerificationFixture(undefined, { route: 'branch' });
    const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
    const configPath = join(directory, 'config.json');
    const messageFile = join(directory, 'message.txt');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: fixture.request.repository,
        defaultBranch: 'main',
        worktreeRoots: { codex: directory, claude: directory },
        manifestName: 'fixture',
        installCommand: 'true',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    writeFileSync(messageFile, 'merge');
    await recordDeliveryMergeObservation(
      loadDeliveryVerification(fixture.verification, fixture.dependencies),
      {
        route: 'branch',
        branch: 'topic',
        reviewedHead: fixture.request.revision,
        base: fixture.request.base,
        integrationTree: fixture.request.integrationTree,
        mergeCommit: commit,
        state: 'confirmed-merge',
      },
      'observed',
      { state: fixture.state },
    );
    const calls: string[][] = [];
    let deletions = 0;
    const raw: Runner = (command) => {
      calls.push(command);
      if (
        command[0] === 'git' &&
        command[1] === 'rev-parse' &&
        command[2] === '--path-format=absolute'
      )
        return { code: 0, stdout: `${tmpdir()}\n`, stderr: '' };
      if (command[0] === 'git' && command[1] === 'fetch')
        return { code: 0, stdout: '', stderr: '' };
      if (command[0] === 'git' && command[1] === 'merge-base')
        return { code: 0, stdout: '', stderr: '' };
      if (command[0] === 'git' && command[1] === 'rev-parse')
        return {
          code: 0,
          stdout:
            command[2] === `${commit}^`
              ? `${fixture.request.base}\n`
              : `${fixture.request.integrationTree}\n`,
          stderr: '',
        };
      if (command[0] === 'git' && command[1] === 'push' && command[3] === '--delete')
        return { code: ++deletions < 3 ? 1 : 0, stdout: '', stderr: 'temporary failure' };
      if (command[0] === 'git' && command[1] === 'ls-remote')
        return deletions === 1
          ? { code: 128, stdout: '', stderr: 'provider unavailable' }
          : { code: 0, stdout: 'still-present\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const options: DirectMergeOptions = {
      configPath,
      branch: 'topic',
      head: fixture.request.revision,
      messageFile,
      worktree: fixture.directory,
      verification: fixture.verification,
    };
    const first = await directMerge(options, { runner: raw, verification: fixture.dependencies });
    const second = await directMerge(options, { runner: raw, verification: fixture.dependencies });
    const third = await directMerge(options, { runner: raw, verification: fixture.dependencies });
    expect(first).toMatchObject({ mergeCommit: commit, failedStep: 'delete' });
    expect(second).toMatchObject({ mergeCommit: commit, failedStep: 'delete' });
    expect(third).toMatchObject({ mergeCommit: commit, failedStep: null });
    expect(deletions).toBe(3);
    expect(
      calls.filter((call) => call[0] === 'git' && call[1] === 'push' && call[3] !== '--delete'),
    ).toHaveLength(0);
  },
);

scenarios.scenario(
  'leaves an absent direct merge outcome unresolved without a second push',
  async () => {
    const fixture = await createDeliveryVerificationFixture(undefined, { route: 'branch' });
    const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
    const configPath = join(directory, 'configuration.json');
    const messageFile = join(directory, 'message.txt');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: fixture.request.repository,
        defaultBranch: 'main',
        worktreeRoots: { codex: directory, claude: directory },
        manifestName: 'fixture',
        installCommand: 'true',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    writeFileSync(messageFile, 'merge');
    await recordDeliveryMergeObservation(
      loadDeliveryVerification(fixture.verification, fixture.dependencies),
      {
        route: 'branch',
        branch: 'topic',
        reviewedHead: fixture.request.revision,
        base: fixture.request.base,
        integrationTree: fixture.request.integrationTree,
        mergeCommit: commit,
        state: 'pending-provider-outcome',
      },
      'unknown',
      { state: fixture.state },
    );
    const calls: string[][] = [];
    const baseRunner = runner(fixture.request, calls);
    const raw: Runner = (command) => {
      if (command[0] === 'git' && command[1] === 'merge-base') {
        calls.push(command);
        return { code: 1, stdout: '', stderr: '' };
      }
      return baseRunner(command);
    };
    const options: DirectMergeOptions = {
      configPath,
      branch: 'topic',
      head: fixture.request.revision,
      messageFile,
      worktree: fixture.directory,
      verification: fixture.verification,
    };
    const first = await directMerge(options, { runner: raw, verification: fixture.dependencies });
    const second = await directMerge(options, { runner: raw, verification: fixture.dependencies });
    expect(first).toMatchObject({ merged: false, failedStep: 'recovery' });
    expect(second).toMatchObject({ merged: false, failedStep: 'recovery' });
    expect(calls.filter((call) => call[0] === 'git' && call[1] === 'fetch')).toHaveLength(2);
    expect(calls.some((call) => call[0] === 'git' && call[1] === 'push')).toBe(false);
    expect(
      readExecutionSnapshot(fixture.state).operations[fixture.request.operationId]?.outcome,
    ).toBe('unknown');
  },
);

await scenarios.settled();
