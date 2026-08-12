import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Reporter } from '../output/reporter';
import type { ProgressSink } from '../types/progress';
import type { RunConfiguration } from '../types/configuration';

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

export function makeConfig(overrides: Partial<RunConfiguration> = {}): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: ['.txt'],
    directories: [],
    ignore_directories: [],
    update_records: false,
    process_directories: true,
    resync_directories: false,
    resync_check_actual_file: false,
    ...overrides,
  };
}
