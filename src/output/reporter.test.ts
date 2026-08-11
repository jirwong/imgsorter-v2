import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { relative } from 'node:path';
import { createSpinner } from 'nanospinner';
import { CliReporter } from './reporter';
import { ProgressEmitter } from './progress';
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

  it('suppresses the spinner in quiet mode even when progress is enabled', () => {
    const reporter = new CliReporter({ quiet: true, verbose: false, progress: true });
    reporter.progress('working');
    reporter.stopProgress();
    expect(createSpinner).not.toHaveBeenCalled();
  });

  it('stops an active spinner before printing a warn or error line', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    reporter.progress('working');
    reporter.warn('careful');
    reporter.error('broken');

    const spinner = vi.mocked(createSpinner).mock.results[0].value as unknown as { stop: Mock };
    expect(spinner.stop).toHaveBeenCalledOnce();
    expect(spinner.stop).toHaveBeenCalledBefore(consoleWarn as unknown as Mock);
    expect(consoleWarn).toHaveBeenCalledWith('careful');
    expect(consoleError).toHaveBeenCalledWith('broken');
  });

  it('stops an active spinner before printing an info line and restarts it on the next progress call', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    reporter.progress('phase 1');
    reporter.info('[1/3] Scanning…');
    reporter.progress('phase 2');

    const spinner = vi.mocked(createSpinner).mock.results[0].value as unknown as { stop: Mock };
    expect(spinner.stop).toHaveBeenCalledOnce();
    expect(consoleLog).toHaveBeenCalledWith('[1/3] Scanning…');
    expect(createSpinner).toHaveBeenCalledTimes(2);
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

  describe('subscribe', () => {
    it('prints the phase marker line then restarts the spinner on phaseStart', () => {
      const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
      const progress = new ProgressEmitter();
      reporter.subscribe(progress);

      progress.emitProgress({ type: 'phaseStart', phase: 'scan', marker: '[1/3]' });

      expect(consoleLog).toHaveBeenCalledWith('[1/3] Scanning…');
      // info-then-progress ordering is a contract: the marker line prints before the spinner restarts
      expect(consoleLog).toHaveBeenCalledBefore(vi.mocked(createSpinner));
      expect(createSpinner).toHaveBeenCalledWith('[1/3] Scanning…');
    });

    it('maps phaseStart for resync and records labels', () => {
      const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
      const progress = new ProgressEmitter();
      reporter.subscribe(progress);

      progress.emitProgress({ type: 'phaseStart', phase: 'resync', marker: '[2/3]' });
      progress.emitProgress({ type: 'phaseStart', phase: 'records', marker: '[3/3]' });

      expect(consoleLog).toHaveBeenCalledWith('[2/3] Resyncing…');
      expect(consoleLog).toHaveBeenCalledWith('[3/3] Rebuilding records…');
    });

    it('maps directoryStart to a Scanning progress line', () => {
      const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
      const progress = new ProgressEmitter();
      reporter.subscribe(progress);

      progress.emitProgress({ type: 'directoryStart', phase: 'scan', directory: 'C:\\Pics' });

      expect(createSpinner).toHaveBeenCalledWith('Scanning C:\\Pics');
    });

    it('maps file events to the relative current-file progress line', () => {
      const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
      const progress = new ProgressEmitter();
      reporter.subscribe(progress);

      progress.emitProgress({
        type: 'file',
        phase: 'scan',
        directory: 'C:\\Pics',
        currentFile: 'C:\\Pics\\sub\\a.txt',
        filesProcessed: 1,
        totalFiles: null,
      });

      expect(createSpinner).toHaveBeenCalledWith(`Scanning C:\\Pics → ${relative('C:\\Pics', 'C:\\Pics\\sub\\a.txt')}`);
    });

    it('uses the Resyncing verb for resync file events', () => {
      const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
      const progress = new ProgressEmitter();
      reporter.subscribe(progress);

      progress.emitProgress({
        type: 'file',
        phase: 'resync',
        directory: 'C:\\Pics',
        currentFile: 'C:\\Pics\\a.txt',
        filesProcessed: 1,
        totalFiles: 2,
      });

      expect(createSpinner).toHaveBeenCalledWith(`Resyncing C:\\Pics → ${relative('C:\\Pics', 'C:\\Pics\\a.txt')}`);
    });

    it('ignores counts events', () => {
      const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
      const progress = new ProgressEmitter();
      reporter.subscribe(progress);

      progress.emitProgress({ type: 'counts', phase: 'scan', filesProcessed: 5, totalFiles: 5 });

      expect(createSpinner).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    });
  });
});
