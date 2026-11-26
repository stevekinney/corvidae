import type { WorkerLike } from '../workers/pool.ts';

interface WorkerListeners {
  message: EventListener;
  error: EventListener;
  messageerror: EventListener;
}

export class WorkerListenerRegistry {
  readonly #workerListeners = new Map<WorkerLike, WorkerListeners>();

  attach(
    worker: WorkerLike,
    handlers: {
      message: (message: unknown) => void;
      error: (message: string) => void;
      messageerror: () => void;
    },
  ): void {
    if (this.#workerListeners.has(worker)) {
      return;
    }

    const listeners: WorkerListeners = {
      message: (event: Event) => {
        if (event instanceof MessageEvent) {
          handlers.message(event.data);
        }
      },
      error: (event: Event) => {
        const message = Reflect.get(event, 'message');
        if (typeof message === 'string') {
          handlers.error(message);
        }
      },
      messageerror: handlers.messageerror,
    };

    this.#workerListeners.set(worker, listeners);
    worker.addEventListener('message', listeners.message);
    worker.addEventListener('error', listeners.error);
    worker.addEventListener('messageerror', listeners.messageerror);
  }

  detach(worker: WorkerLike): void {
    const listeners = this.#workerListeners.get(worker);
    if (!listeners) return;
    worker.removeEventListener('message', listeners.message);
    worker.removeEventListener('error', listeners.error);
    worker.removeEventListener('messageerror', listeners.messageerror);
    this.#workerListeners.delete(worker);
  }

  detachIfIdle(worker: WorkerLike, workerIsIdle: (worker: WorkerLike) => boolean): void {
    if (workerIsIdle(worker)) {
      this.detach(worker);
    }
  }

  detachAll(): void {
    for (const worker of this.#workerListeners.keys()) {
      this.detach(worker);
    }
  }
}
