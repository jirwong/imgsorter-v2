import { describe, it, expect, vi } from 'vitest';
import { iterateDirectories } from './iterate-directories';
import { RunAbortedError } from './abort';
import type { RunConfiguration } from '../types/configuration';
import type { Reporter } from '../output/reporter';

function makeConfig(directories: string[], ignoreDirectories: string[] = []): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: ['.txt'],
    directories,
    ignore_directories: ignoreDirectories,
    update_records: false,
    process_directories: false,
    resync_directories: false,
    resync_check_actual_file: false,
  };
}

function makeReporter(): Reporter {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    printSummary: vi.fn(),
  };
}

describe('iterateDirectories', () => {
  it('calls the body once per non-ignored directory and emits directoryStart before it', async () => {
    const config = makeConfig(['/a', '/b']);
    const reporter = makeReporter();
    const progress = { emitProgress: vi.fn() };
    const body = vi.fn();

    await iterateDirectories('scan', { config, reporter, progress, signal: new AbortController().signal }, body);

    expect(body).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenNthCalledWith(1, '/a');
    expect(body).toHaveBeenNthCalledWith(2, '/b');
    expect(progress.emitProgress).toHaveBeenNthCalledWith(1, {
      type: 'directoryStart',
      phase: 'scan',
      directory: '/a',
    });
    expect(progress.emitProgress).toHaveBeenNthCalledWith(2, {
      type: 'directoryStart',
      phase: 'scan',
      directory: '/b',
    });
    expect(reporter.info).not.toHaveBeenCalled();
  });

  it('skips ignored directories with an info message', async () => {
    const config = makeConfig(['/a', '/ignored', '/b'], ['/ignored']);
    const reporter = makeReporter();
    const progress = { emitProgress: vi.fn() };
    const body = vi.fn();

    await iterateDirectories('resync', { config, reporter, progress, signal: new AbortController().signal }, body);

    expect(body).toHaveBeenCalledTimes(2);
    expect(progress.emitProgress).toHaveBeenCalledTimes(2);
    expect(progress.emitProgress).toHaveBeenNthCalledWith(1, {
      type: 'directoryStart',
      phase: 'resync',
      directory: '/a',
    });
    expect(progress.emitProgress).toHaveBeenNthCalledWith(2, {
      type: 'directoryStart',
      phase: 'resync',
      directory: '/b',
    });
    expect(reporter.info).toHaveBeenCalledWith('Ignoring directory: /ignored');
  });

  it('throws RunAbortedError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const body = vi.fn();

    await expect(
      iterateDirectories(
        'scan',
        {
          config: makeConfig(['/a']),
          reporter: makeReporter(),
          progress: { emitProgress: vi.fn() },
          signal: controller.signal,
        },
        body,
      ),
    ).rejects.toBeInstanceOf(RunAbortedError);
    expect(body).not.toHaveBeenCalled();
  });
});
