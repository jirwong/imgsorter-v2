import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Reporter } from '../output/reporter';
import type { ProgressSink } from '../types/progress';

export type MockReporter = {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  printSummary: Mock;
};

export function makeMockReporter(): MockReporter {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    printSummary: vi.fn(),
  };
}

export type MockProgress = {
  emitProgress: Mock;
};

export function makeMockProgress(): MockProgress {
  return { emitProgress: vi.fn() };
}

export function asReporter(mock: MockReporter): Reporter {
  return mock as unknown as Reporter;
}

export function asProgress(mock: MockProgress): ProgressSink {
  return mock as unknown as ProgressSink;
}
