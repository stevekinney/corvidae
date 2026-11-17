/**
 * What the run page reads for an instance of a workflow file, beside the engine's run: the history
 * the Bureau keeps of it (which step it started, and how many times), the steps of the version it
 * ran (their names and how many there are), and the workflow's current version, which says whether
 * the run ran on an older one (COR-2424, rows 54l, 54y, 14t, 55b, 55d).
 *
 * Every read is asked only for a workflow file's instance, and only once the type is known, so a
 * chat's run or a goal's attempt reads nothing here. A read that fails leaves its part out: the page
 * is whole without it, and says only what it knows. Created while a component initializes.
 */
import { createQuery } from '@tanstack/svelte-query';

import type { WorkflowRunHistoryEvent } from '../../../lib/workflow-files.ts';
import {
  getWorkflowFile,
  getWorkflowRunHistory,
  listWorkflowRevisions,
  listWorkflowVersionLabels,
} from '../../../lib/workflow-files.ts';
import { isBuiltInWorkflow, workflowTypeName } from '../../../lib/workflow-type-name.ts';
import {
  instanceProgress,
  versionStanding,
  type InstanceProgress,
  type VersionStanding,
} from './run-instance.ts';

/** What the page knows of the run that decides what is read. */
export interface RunInstanceSource {
  readonly runId: string;
  /** The workflow type the run ran, from the engine or the Bureau's record; `undefined` while unknown. */
  readonly type: string | undefined;
  /** The workflow version the engine recorded the run on. */
  readonly ranVersion: string | undefined;
  /** When the run last changed, so a read of its history is made again when it moves. */
  readonly updatedAt: number | undefined;
  /** Whether the caller may read workflows. */
  readonly allowed: boolean;
}

export class RunInstance {
  readonly #source: () => RunInstanceSource;
  readonly #history;
  readonly #revisions;
  readonly #file;
  readonly #labels;

  constructor(source: () => RunInstanceSource) {
    this.#source = source;
    const asked = (): boolean => {
      const read = source();
      // An owner's workflow file is a bare stem; a plugin's code workflow is `plugin:name` and has
      // no file, revisions or history of the Bureau's to read, so it is not asked for.
      return (
        read.allowed &&
        read.type !== undefined &&
        !read.type.includes(':') &&
        !isBuiltInWorkflow(read.type)
      );
    };
    this.#history = createQuery(() => {
      const read = source();
      return {
        queryKey: ['run-instance', 'history', read.runId, read.updatedAt ?? 0] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          getWorkflowRunHistory(read.runId, { signal }),
        enabled: asked(),
        retry: false,
      };
    });
    this.#revisions = createQuery(() => {
      const read = source();
      return {
        queryKey: ['run-instance', 'revisions', read.type ?? ''] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          listWorkflowRevisions(read.type ?? '', { signal }),
        enabled: asked(),
        retry: false,
      };
    });
    this.#file = createQuery(() => {
      const read = source();
      return {
        queryKey: ['run-instance', 'file', read.type ?? ''] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          getWorkflowFile(read.type ?? '', { signal }),
        enabled: asked(),
        retry: false,
      };
    });
    this.#labels = createQuery(() => {
      const read = source();
      return {
        queryKey: ['run-instance', 'version-labels', read.type ?? ''] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          listWorkflowVersionLabels(read.type ?? '', { signal }),
        enabled: asked(),
        retry: false,
      };
    });
  }

  /** The steps of the version the run ran, when the workflow's revisions say. */
  get steps(): readonly Readonly<Record<string, unknown>>[] | undefined {
    const ran = this.#source().ranVersion;
    return this.#revisions.data?.find((revision) => revision.workflowVersion === ran)?.document
      .steps;
  }

  /** The events of the run's history, once it has been read. */
  get events(): readonly WorkflowRunHistoryEvent[] {
    return this.#history.data?.events ?? [];
  }

  /** How far the run got, once its history has been read. */
  get progress(): InstanceProgress | undefined {
    const events = this.#history.data?.events;
    return events === undefined ? undefined : instanceProgress(events, this.steps);
  }

  /** Where the version the run ran stands against the workflow's current one. */
  get version(): VersionStanding | undefined {
    const ran = this.#source().ranVersion;
    if (ran === undefined || this.#file.data === undefined) return undefined;
    return versionStanding(ran, this.#file.data.version, this.#labels.data);
  }

  /**
   * What a person calls the workflow, once the Bureau has said it is a workflow file: its title, else
   * its identifier in words ("Release notes"). `undefined` for a run that is no workflow file's.
   */
  get name(): string | undefined {
    const file = this.#file.data;
    const type = this.#source().type;
    if (file === undefined || type === undefined) return undefined;
    const title = file.title?.trim();
    return title === undefined || title === '' ? workflowTypeName(type) : title;
  }
}
