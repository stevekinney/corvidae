#!/usr/bin/env bun
// Chef design critique: the script half of the pre-build critique of an issue's design rows. The
// critique itself is a read-only Opus `design-reviewer` agent (`.claude/workflows/deliver-issue.js`
// runs it before the build, for an issue whose brief was refused for want of `rows.resolved.json`);
// a read-only agent cannot write the file, and a model's file is not trusted, so this script emits
// what the critique needs and writes only what validates.
//
// Usage:
//   bun scripts/chef/design-critique.ts rows  <ID> [--out-dir <dir>]
//   bun scripts/chef/design-critique.ts write <ID> --input <file> [--out-dir <dir>]
//
// `rows` prints, as JSON, the issue's design row IDs, its literal pixel criteria (such as
// COR-2444's 700px threshold) and its description: what the critique checks the rows against.
// `write` takes the critique's JSON (`rows`, `checked`, `conflicts`; see
// `design-rows-resolved.ts`), validates it against the issue (every row declares states, every
// literal criterion is checked, every conflict is a decision or a deferral with a reason) and
// writes `<briefs directory>/<ID>/rows.resolved.json`, the file `brief.ts` requires. The briefs
// directory is the main checkout's `tmp/chef/briefs` unless `--out-dir` names another.
//
// Exit codes: 0 done; 1 the critique is invalid (one line per problem, nothing written) or Linear
// failed; 2 invalid usage.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { designRowsOf } from './brief.ts';
import {
  literalCriteria,
  RESOLVED_VERSION,
  resolvedPath,
  validateResolved,
} from './design-rows-resolved.ts';
import { createClient, fetchIssue, type LinearDependencies, LinearError } from './linear.ts';
import { emitResult, parseOptions, UsageError } from './process-runner.ts';
import { resolveMainCheckout } from './repository-locations.ts';

export async function runCritique(
  argv: string[],
  dependencies: LinearDependencies = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, { values: ['input', 'out-dir'] });
  const [command, identifier] = parsed.positionals;
  if (
    parsed.positionals.length !== 2 ||
    (command !== 'rows' && command !== 'write') ||
    identifier === undefined ||
    !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)
  )
    throw new UsageError(
      'Usage: design-critique.ts rows <ID> [--out-dir <dir>] | write <ID> --input <file> [--out-dir <dir>]',
    );
  const input = parsed.values['input'];
  if (command === 'write' && input === undefined) throw new UsageError('--input is required.');
  try {
    const issue = await fetchIssue(createClient(dependencies), identifier);
    const description = (issue.description ?? '').trim();
    const rowIds = designRowsOf(description);
    if (command === 'rows')
      return {
        code: 0,
        output: JSON.stringify(
          {
            issue: issue.identifier,
            title: issue.title,
            rowIds,
            literals: literalCriteria(description),
            description,
          },
          null,
          2,
        ),
      };
    const briefs = parsed.values['out-dir'] ?? join(resolveMainCheckout(), 'tmp', 'chef', 'briefs');
    let critique: unknown;
    try {
      critique = JSON.parse(readFileSync(input as string, 'utf8'));
    } catch {
      return { code: 1, output: `${input} is not readable JSON.` };
    }
    const file = {
      ...(typeof critique === 'object' && critique !== null ? critique : {}),
      version: RESOLVED_VERSION,
      issue: issue.identifier,
    };
    const problems = validateResolved(file, {
      issue: issue.identifier,
      rowIds,
      literals: literalCriteria(description),
    });
    if (rowIds.length === 0)
      problems.unshift(`${issue.identifier} names no design rows to resolve`);
    if (problems.length > 0)
      return {
        code: 1,
        output: `Refused: the critique is not valid; nothing was written.\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
      };
    const path = resolvedPath(briefs, issue.identifier);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    return { code: 0, output: `rows.resolved.json for ${issue.identifier} written to ${path}.` };
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    return { code: 1, output: error.message };
  }
}

if (import.meta.main) {
  try {
    const result = await runCritique(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), result);
    process.exitCode = result.code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
