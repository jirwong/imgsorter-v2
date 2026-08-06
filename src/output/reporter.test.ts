import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createSpinner } from 'nanospinner';
import { CliReporter } from './reporter';
import type { RunSummary } from '../types/run-summary';

vi.mock('nanospinner', () => {
  const spinner = {
    start: vi.fn(() => spinner),
    update: vi.fn(() => spinner),
    stop: vi.fn(() => spinner),
  };
  return { createSpinner: vi.fn(() => spinner) };
});

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    phases: [{ name: 'scan', elapsedMs: 12 }],
    filesScanned: 4,
    entriesUpserted: 3,
    duplicateGroups: 1,
    duplicateFiles: 2,
    staleRemoved: 5,
    errors: [],
    ...overrides,
  };
}

describe('CliReporter', () => {
  let consoleLog: Mock;
  let consoleWarn: Mock;
  let consoleError: Mock;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints info by default and suppresses it in quiet mode', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.info('hello');
    expect(consoleLog).toHaveBeenCalledWith('hello');

    const quiet = new CliReporter({ quiet: true, verbose: false, progress: false });
    quiet.info('hidden');
    expect(consoleLog).not.toHaveBeenCalledWith('hidden');
  });

  it('gates debug output on verbose and suppresses it in quiet mode', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.debug('hidden');
    expect(consoleLog).not.toHaveBeenCalledWith('[debug] hidden');

    const verbose = new CliReporter({ quiet: false, verbose: true, progress: false });
    verbose.debug('shown');
    expect(consoleLog).toHaveBeenCalledWith('[debug] shown');

    const quietVerbose = new CliReporter({ quiet: true, verbose: true, progress: false });
    quietVerbose.debug('hidden again');
    expect(consoleLog).not.toHaveBeenCalledWith('[debug] hidden again');
  });

  it('always prints warnings and errors', () => {
    const reporter = new CliReporter({ quiet: true, verbose: false, progress: false });
    reporter.warn('careful');
    reporter.error('broken');
    expect(consoleWarn).toHaveBeenCalledWith('careful');
    expect(consoleError).toHaveBeenCalledWith('broken');
  });

  it('does not touch the spinner when progress is disabled', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.progress('working');
    reporter.stopProgress();
    expect(createSpinner).not.toHaveBeenCalled();
  });

  it('drives the spinner when progress is enabled', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    reporter.progress('starting');
    reporter.progress('next');
    reporter.stopProgress();

    expect(createSpinner).toHaveBeenCalledWith('starting');
    const spinner = vi.mocked(createSpinner).mock.results[0].value as unknown as {
      start: Mock;
      update: Mock;
      stop: Mock;
    };
    expect(spinner.start).toHaveBeenCalledOnce();
    expect(spinner.update).toHaveBeenCalledWith({ text: 'next' });
    expect(spinner.stop).toHaveBeenCalledOnce();
  });

  it('prints a per-phase summary line for each executed phase', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.printSummary(
      makeSummary({
        phases: [
          { name: 'scan', elapsedMs: 12 },
          { name: 'resync', elapsedMs: 4 },
          { name: 'records', elapsedMs: 3 },
        ],
      }),
    );

    expect(consoleLog).toHaveBeenCalledWith('Scan: 4 files scanned, 3 entries upserted (12 ms)');
    expect(consoleLog).toHaveBeenCalledWith('Resync: 5 stale entries removed (4 ms)');
    expect(consoleLog).toHaveBeenCalledWith('Records: 1 duplicate group, 2 duplicate files (3 ms)');
  });

  it('reports collected errors via warn', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.printSummary(makeSummary({ errors: ['Scan C:\\bad: EACCES'] }));

    expect(consoleWarn).toHaveBeenCalledWith('Encountered 1 error(s):');
    expect(consoleWarn).toHaveBeenCalledWith('  - Scan C:\\bad: EACCES');
  });

  it('hides the summary lines but keeps error warnings in quiet mode', () => {
    const reporter = new CliReporter({ quiet: true, verbose: false, progress: false });
    reporter.printSummary(makeSummary({ errors: ['Scan C:\\bad: EACCES'] }));

    expect(consoleLog).not.toHaveBeenCalledWith(expect.stringContaining('files scanned'));
    expect(consoleWarn).toHaveBeenCalledWith('  - Scan C:\\bad: EACCES');
  });
});
