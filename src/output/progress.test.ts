import { describe, it, expect, vi } from 'vitest';
import { ProgressEmitter } from './progress';
import type { ProgressEvent, ProgressSink } from '../types/progress';

describe('ProgressEmitter', () => {
  it('delivers events to a subscribed listener', () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const event: ProgressEvent = { type: 'phaseStart', phase: 'scan', marker: '[1/2]' };
    emitter.emitProgress(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it('supports unsubscribing', () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    const off = emitter.on(listener);
    off();

    emitter.emitProgress({ type: 'directoryStart', phase: 'scan', directory: '/tmp/pics' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('is usable through the ProgressSink emit-only view', () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const sink: ProgressSink = emitter;
    sink.emitProgress({
      type: 'file',
      phase: 'scan',
      directory: '/tmp/pics',
      currentFile: '/tmp/pics/a.jpg',
      filesProcessed: 1,
      totalFiles: null,
    });
    sink.emitProgress({ type: 'counts', phase: 'scan', filesProcessed: 1, totalFiles: 1 });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies every subscribed listener', () => {
    const emitter = new ProgressEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on(a);
    emitter.on(b);

    emitter.emitProgress({ type: 'phaseStart', phase: 'records', marker: '[3/3]' });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
