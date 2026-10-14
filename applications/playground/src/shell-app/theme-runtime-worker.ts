/**
 * Entry point of the theme evaluation worker (COR-254): it wires `createEvaluationHandler` to
 * the worker's messages and reads neither the network nor storage.
 */

import type { EvaluationRequest, EvaluationResponse } from './theme-worker-evaluator.ts';
import { createEvaluationHandler } from './theme-worker-handler.ts';

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: { data: EvaluationRequest }) => void): void;
  postMessage(message: EvaluationResponse): void;
};

const scope = globalThis as unknown as WorkerScope;
const handle = createEvaluationHandler((response) => scope.postMessage(response));

scope.addEventListener('message', (event) => handle(event.data));
