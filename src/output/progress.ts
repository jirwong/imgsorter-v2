import { EventEmitter } from 'node:events';
import type { ProgressEvent, ProgressSink } from '../types/progress';

export type ProgressListener = (event: ProgressEvent) => void;

export class ProgressEmitter implements ProgressSink {
  private readonly emitter = new EventEmitter();

  emitProgress(event: ProgressEvent): void {
    this.emitter.emit('progress', event);
  }

  on(listener: ProgressListener): () => void {
    this.emitter.on('progress', listener);
    return () => {
      this.emitter.off('progress', listener);
    };
  }
}
