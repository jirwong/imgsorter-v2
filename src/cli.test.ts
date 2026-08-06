import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { main } from './cli';

async function makeTempDir(prefix = 'cli-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function removeDirRecursive(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

async function createFile(root: string, relativePath: string, content: string): Promise<string> {
  const fullPath = join(root, relativePath);
  await fs.mkdir(dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
}

function toYaml(config: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function makeConfigYaml(dir: string): string {
  return toYaml({
    dbName: join(dir, 'test.db'),
    extensions: 'txt',
    directories: [join(dir, 'pics')],
    ignore_directories: [],
    process_directories: true,
    update_records: true,
    resync_directories: false,
    resync_check_actual_file: false,
  });
}

describe('main', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // commander writes --help/--version output and errors directly to the streams
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
    vi.restoreAllMocks();
  });

  it('runs with a config file passed via --config', async () => {
    await createFile(rootDir, 'pics/a.txt', 'hello');
    await fs.writeFile(join(rootDir, 'config.yaml'), makeConfigYaml(rootDir));

    const code = await main(['--config', join(rootDir, 'config.yaml')]);

    expect(code).toBe(0);
    const db = new Database(join(rootDir, 'test.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(1);
  });

  it('uses the default config.yaml path when no --config is given', async () => {
    await createFile(rootDir, 'pics/a.txt', 'hello');
    await fs.writeFile(join(rootDir, 'config.yaml'), makeConfigYaml(rootDir));

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootDir);
    try {
      const code = await main([]);
      expect(code).toBe(0);
    } finally {
      cwdSpy.mockRestore();
    }

    const db = new Database(join(rootDir, 'test.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(1);
  });

  it('returns 1 when the config file is missing', async () => {
    const code = await main(['--config', join(rootDir, 'missing.yaml')]);
    expect(code).toBe(1);
  });

  it('returns 1 when the config file is invalid', async () => {
    await fs.writeFile(join(rootDir, 'config.yaml'), 'dbName: 123');
    const code = await main(['--config', join(rootDir, 'config.yaml')]);
    expect(code).toBe(1);
  });

  it('returns 1 for an unknown CLI flag', async () => {
    const code = await main(['--bogus']);
    expect(code).toBe(1);
  });

  it('returns 2 when the run fails fatally', async () => {
    await fs.writeFile(
      join(rootDir, 'config.yaml'),
      toYaml({
        dbName: join(rootDir, 'missing', 'sub', 'test.db'),
        extensions: 'txt',
        directories: [],
        ignore_directories: [],
        process_directories: false,
        update_records: false,
        resync_directories: false,
        resync_check_actual_file: false,
      }),
    );

    const code = await main(['--config', join(rootDir, 'config.yaml')]);
    expect(code).toBe(2);
  });

  it('handles a leading -- separator forwarded by pnpm', async () => {
    await createFile(rootDir, 'pics/a.txt', 'hello');
    await fs.writeFile(join(rootDir, 'config.yaml'), makeConfigYaml(rootDir));

    // `pnpm start -- --config x` forwards the literal `--` as the first arg
    const code = await main(['--', '--config', join(rootDir, 'config.yaml')]);

    expect(code).toBe(0);
    const db = new Database(join(rootDir, 'test.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(1);
  });

  it('returns 0 for --help', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
  });

  it('returns 0 for --version', async () => {
    const code = await main(['--version']);
    expect(code).toBe(0);
  });
});
