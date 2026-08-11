import { describe, it, expect } from 'vitest';
import { RunAbortedError, throwIfAborted } from './abort';

describe('throwIfAborted', () => {
  it('does nothing when the signal is not aborted', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it('throws RunAbortedError when the signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(RunAbortedError);
  });

  it('RunAbortedError is a distinct error type', () => {
    const error = new RunAbortedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RunAbortedError');
  });
});
