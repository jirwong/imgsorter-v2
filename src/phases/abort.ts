export class RunAbortedError extends Error {
  constructor() {
    super('Run aborted');
    this.name = 'RunAbortedError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunAbortedError();
  }
}
