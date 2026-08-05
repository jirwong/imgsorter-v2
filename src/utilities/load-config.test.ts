import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunConfiguration } from './load-config';

async function makeTempDir(prefix = 'load-config-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function removeDirRecursive(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

function writeConfig(text: string) {
  return fs.writeFile(join(tempDir, 'config.yaml'), text, 'utf8');
}

let cwdBefore: string;
let tempDir: string;

beforeEach(async () => {
  cwdBefore = process.cwd();
  tempDir = await makeTempDir();
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(cwdBefore);
  await removeDirRecursive(tempDir);
});

describe('loadRunConfiguration', () => {
  it('loads a full configuration from YAML', async () => {
    const yamlContent = `
      dbName: test.db
      directories:
        - ./images
        - ./more-images
      ignore_directories:
        - ./images/ignore-this
      extensions:
        - .png
        - jpg
      update_records: true
      process_directories: false
      resync_directories: true
      resync_check_actual_file: true
    `;

    await writeConfig(yamlContent);

    const config = await loadRunConfiguration('config.yaml');

    expect(config.dbName).toBe('test.db');
    expect(config.directories).toEqual(['./images', './more-images']);
    expect(config.ignore_directories).toEqual(['./images/ignore-this']);
    expect(config.extensions).toEqual(['.png', '.jpg']);
    expect(config.update_records).toBe(true);
    expect(config.process_directories).toBe(false);
    expect(config.resync_directories).toBe(true);
    expect(config.resync_check_actual_file).toBe(true);
  });

  it('normalizes extension casing and leading dots', async () => {
    const yamlContent = `
      dbName: test.db
      directories:
        - ./images
      ignore_directories: []
      extensions:
        - JPG
        - .pNg
        - ' gif '
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `;

    await writeConfig(yamlContent);

    const config = await loadRunConfiguration('config.yaml');

    expect(config.extensions).toEqual(['.jpg', '.png', '.gif']);
  });

  it('accepts extensions as a comma-separated string', async () => {
    const yamlContent = `
      dbName: test.db
      directories:
        - ./images
      ignore_directories: []
      extensions: JPG, .png, gif
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `;

    await writeConfig(yamlContent);

    const config = await loadRunConfiguration('config.yaml');

    expect(config.extensions).toEqual(['.jpg', '.png', '.gif']);
  });

  it('throws if dbName is not a string', async () => {
    const yamlContent = `
      dbName: 123
      directories:
        - ./images
      ignore_directories: []
      extensions: .png
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `;

    await writeConfig(yamlContent);

    await expect(loadRunConfiguration('config.yaml')).rejects.toThrow(
      'config.yaml: dbName Invalid input: expected string, received number',
    );
  });

  it('throws if directories is not an array of strings', async () => {
    const yamlContent = `
      dbName: test.db
      directories: ./images
      ignore_directories: []
      extensions: .png
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `;

    await writeConfig(yamlContent);

    await expect(loadRunConfiguration('config.yaml')).rejects.toThrow(
      'config.yaml: directories Invalid input: expected array, received string',
    );
  });

  it('throws if ignore_directories is not an array of strings', async () => {
    const yamlContent = `
      dbName: test.db
      directories:
        - ./images
      ignore_directories: ./ignore
      extensions: .png
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `;

    await writeConfig(yamlContent);

    await expect(loadRunConfiguration('config.yaml')).rejects.toThrow(
      'config.yaml: ignore_directories Invalid input: expected array, received string',
    );
  });

  it('throws if extensions is neither a string nor an array', async () => {
    const yamlContent = `
      dbName: test.db
      directories:
        - ./images
      ignore_directories: []
      extensions: 42
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `;

    await writeConfig(yamlContent);

    await expect(loadRunConfiguration('config.yaml')).rejects.toThrow('config.yaml: extensions Invalid input');
  });

  it.each([
    ['update_records', '"yes"'],
    ['process_directories', '1'],
    ['resync_directories', '"nope"'],
    ['resync_check_actual_file', '123'],
  ])('throws if %s is not a boolean', async (name, value) => {
    const yamlContent = `
      dbName: test.db
      directories:
        - ./images
      ignore_directories: []
      extensions: .png
      update_records: true
      process_directories: true
      resync_directories: false
      resync_check_actual_file: false
    `
      .replace(`      ${name}: true\n`, `      ${name}: ${value}\n`)
      .replace(`      ${name}: false\n`, `      ${name}: ${value}\n`);

    await writeConfig(yamlContent);

    await expect(loadRunConfiguration('config.yaml')).rejects.toThrow(
      `config.yaml: ${name} Invalid input: expected boolean`,
    );
  });

  it('throws when the YAML root is not an object', async () => {
    await writeConfig('just a string');

    await expect(loadRunConfiguration('config.yaml')).rejects.toThrow(
      'config.yaml: (root) Invalid input: expected object',
    );
  });
});
