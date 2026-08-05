import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { RunConfiguration } from '../types/configuration';

export async function loadRunConfiguration(fileName: string): Promise<RunConfiguration> {
  const absPath = resolve(process.cwd(), fileName);
  const text = await readFile(absPath, 'utf8');
  const raw = YAML.parse(text) as unknown;

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.yaml: root must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.dbName !== 'string') {
    throw new Error('config.yaml: dbName must be a string');
  }

  if (!Array.isArray(obj.directories) || !obj.directories.every((d) => typeof d === 'string')) {
    throw new Error('config.yaml: directories must be an array of strings');
  }

  if (!Array.isArray(obj.ignore_directories) || !obj.ignore_directories.every((d) => typeof d === 'string')) {
    throw new Error('config.yaml: ignore_directories must be an array of strings');
  }

  let extensions: string[] = [];
  if (Array.isArray(obj.extensions)) {
    if (!obj.extensions.every((e) => typeof e === 'string')) {
      throw new Error('config.yaml: extensions must be an array of strings');
    }
    extensions = normalizeExtensions(obj.extensions as string[]);
  } else if (typeof obj.extensions === 'string') {
    extensions = normalizeExtensions((obj.extensions as string).split(','));
  } else {
    throw new Error('config.yaml: extensions must be a string or an array of strings');
  }

  const update_records = requireBoolean(obj.update_records, 'update_records');
  const process_directories = requireBoolean(obj.process_directories, 'process_directories');
  const resync_directories = requireBoolean(obj.resync_directories, 'resync_directories');
  const resync_check_actual_file = requireBoolean(obj.resync_check_actual_file, 'resync_check_actual_file');

  return {
    dbName: obj.dbName,
    directories: obj.directories as string[],
    ignore_directories: obj.ignore_directories as string[],
    extensions,
    update_records,
    process_directories,
    resync_directories,
    resync_check_actual_file,
  };
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`config.yaml: ${name} must be a boolean`);
  }
  return value;
}

function normalizeExtensions(extensions: string[]): string[] {
  return extensions
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}
