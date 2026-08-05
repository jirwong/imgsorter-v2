import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { RunConfiguration } from '../types/configuration';

const extensionSchema = z.union([z.string(), z.array(z.string())]).transform((value) => {
  const raw = Array.isArray(value) ? value : value.split(',');
  return raw
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
});

const configSchema = z.object({
  dbName: z.string(),
  extensions: extensionSchema,
  directories: z.array(z.string()),
  ignore_directories: z.array(z.string()),
  update_records: z.boolean(),
  process_directories: z.boolean(),
  resync_directories: z.boolean(),
  resync_check_actual_file: z.boolean(),
});

function formatError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `config.yaml: ${path} ${issue.message}`;
    })
    .join('\n');
}

export async function loadRunConfiguration(fileName: string): Promise<RunConfiguration> {
  const absPath = resolve(process.cwd(), fileName);
  const text = await readFile(absPath, 'utf8');
  const raw = YAML.parse(text) as unknown;

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatError(result.error));
  }

  return result.data;
}
