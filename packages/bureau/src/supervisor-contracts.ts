import type { EventMap, ObservableLike, Observer, Subscription } from '@lostgradient/lifecycle';
import type { RunResult } from '@lostgradient/operative';

import type { AgentDefinitions, AgentNames, BureauAgentCatalog } from './agent-catalog';

/**
 * Metadata-only view of a catalog entry handed to a `RoutingStrategy` — just
 * the name. Descriptors are built from catalog keys, never from the agent
 * objects themselves: reading a lazy agent's own `.name` would give the
 * `'(lazy)'` placeholder rather than its catalog key, and routing from keys
 * means a lazy agent never has to load to decide whether to select it. An
 * agent's `skillDescriptors` stay on the catalog entry, where
 * `createAgentDiscoveryTool` searches them; its `description` is carried
 * here as a string.
 */
export interface AgentDescriptor<D extends AgentDefinitions = AgentDefinitions> {
  readonly name: AgentNames<D>;
  /**
   * The agent's `description` when it declares one, read from the catalog entry (a string, never a
   * load of the agent). `createDecisionRouting` shows it to the model beside the name.
   */
  readonly description?: string;
}

/**
 * Chooses one or more agents for a task from the catalog's descriptors.
 * `Promise<...>` is a real branch, not the whole return type, because
 * `createRoundRobinRouting`/`createFanOutRouting` resolve synchronously; a
 * caller-supplied strategy may await external state (a policy lookup, an
 * LLM-based router) before deciding.
 */
export type RoutingStrategy<D extends AgentDefinitions> = (
  task: string,
  descriptors: readonly AgentDescriptor<D>[],
) => AgentNames<D> | readonly AgentNames<D>[] | Promise<AgentNames<D> | readonly AgentNames<D>[]>;

export type SynthesisStrategy = (results: SupervisorTaskResult[]) => string | Promise<string>;

export interface SupervisorTaskResult {
  task: string;
  agentName: string;
  result?: RunResult;
  error?: unknown;
}

export interface SupervisorResult {
  task: string;
  agentResults: SupervisorTaskResult[];
  synthesis: string;
}

export interface PipelineStage<D extends AgentDefinitions> {
  agentName: AgentNames<D>;
  mapInput?: (previousOutput: string, originalTask: string) => string;
}

// ---------------------------------------------------------------------------
// Supervisor event classes
// ---------------------------------------------------------------------------

export class TaskRoutedEvent extends Event {
  static readonly type = 'task.routed' as const;
  readonly task: string;
  readonly agentNames: string[];
  constructor(task: string, agentNames: string[]) {
    super(TaskRoutedEvent.type);
    this.task = task;
    this.agentNames = agentNames;
  }
}

export class TaskCompletedEvent extends Event {
  static readonly type = 'task.completed' as const;
  readonly task: string;
  readonly agentName: string;
  readonly result: RunResult;
  constructor(task: string, agentName: string, result: RunResult) {
    super(TaskCompletedEvent.type);
    this.task = task;
    this.agentName = agentName;
    this.result = result;
  }
}

export class TaskFailedEvent extends Event {
  static readonly type = 'task.failed' as const;
  readonly task: string;
  readonly agentName: string;
  readonly error: unknown;
  constructor(task: string, agentName: string, error: unknown) {
    super(TaskFailedEvent.type);
    this.task = task;
    this.agentName = agentName;
    this.error = error;
  }
}

export class SynthesisStartedEvent extends Event {
  static readonly type = 'synthesis.started' as const;
  readonly task: string;
  readonly results: SupervisorTaskResult[];
  constructor(task: string, results: SupervisorTaskResult[]) {
    super(SynthesisStartedEvent.type);
    this.task = task;
    this.results = results;
  }
}

export class SynthesisCompletedEvent extends Event {
  static readonly type = 'synthesis.completed' as const;
  readonly task: string;
  readonly synthesis: string;
  constructor(task: string, synthesis: string) {
    super(SynthesisCompletedEvent.type);
    this.task = task;
    this.synthesis = synthesis;
  }
}

export interface SupervisorEventMap extends EventMap {
  [TaskRoutedEvent.type]: TaskRoutedEvent;
  [TaskCompletedEvent.type]: TaskCompletedEvent;
  [TaskFailedEvent.type]: TaskFailedEvent;
  [SynthesisStartedEvent.type]: SynthesisStartedEvent;
  [SynthesisCompletedEvent.type]: SynthesisCompletedEvent;
}

export type SupervisorEvents = SupervisorEventMap;

export type SupervisorEventType = keyof SupervisorEventMap & string;

export interface CreateSupervisorOptions<D extends AgentDefinitions> {
  agents: BureauAgentCatalog<D>;
  routing: RoutingStrategy<D>;
  synthesis?: SynthesisStrategy;
  maximumDelegations?: number;
  signal?: AbortSignal;
}

export interface Supervisor<D extends AgentDefinitions = AgentDefinitions> {
  delegate(task: string): Promise<SupervisorResult>;
  delegateAll(tasks: string[], options?: { parallel?: boolean }): Promise<SupervisorResult[]>;
  pipeline(task: string, stages: PipelineStage<D>[]): Promise<SupervisorResult>;
  addEventListener: <K extends SupervisorEventType>(
    type: K,
    listener: (event: SupervisorEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <K extends SupervisorEventType>(
    type: K,
    listener: (event: SupervisorEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  on: <K extends SupervisorEventType>(type: K) => ObservableLike<SupervisorEventMap[K]>;
  once: <K extends SupervisorEventType>(
    type: K,
    listener: (event: SupervisorEventMap[K]) => void,
  ) => void;
  subscribe: <K extends SupervisorEventType>(
    type: K,
    observerOrNext?: Observer<SupervisorEventMap[K]> | ((value: SupervisorEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<SupervisorEventMap[SupervisorEventType]>;
}
