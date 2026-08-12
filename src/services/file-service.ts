import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, extname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileEntry } from '../types/file-types';

const EDGE_CHUNK_SIZE = 16 * 1024; // 16KB

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readFileInfo(path: string, getHash: boolean = true): Promise<FileEntry> {
  const fd = await fs.open(path, 'r');
  try {
    const stats = await fd.stat();

    const size = stats.size;
    const directory = dirname(path);
    const extension = extname(path);
    const filename = basename(path);
    const birthtime = stats.birthtime;
    const hash = getHash ? await getHashEdges(path, size) : undefined;

    return {
      size,
      directory,
      extension,
      path,
      filename,
      birthtime,
      hash,
    };
  } finally {
    await fd.close();
  }
}

export async function getHashEdges(path: string, size: number, algorithm: string = 'sha256'): Promise<string> {
  const fd = await fs.open(path, 'r');
  try {
    const firstLen = Math.min(EDGE_CHUNK_SIZE, size);
    const lastLen = Math.min(EDGE_CHUNK_SIZE, Math.max(0, size - firstLen));

    const hash = createHash(algorithm);

    // Read first chunk
    if (firstLen > 0) {
      const firstBuf = Buffer.allocUnsafe(firstLen);
      await fd.read(firstBuf, 0, firstLen, 0);
      hash.update(firstBuf);
    }

    // Read last chunk (avoid double-reading if file smaller than 2 * EDGE_CHUNK_SIZE)
    if (lastLen > 0) {
      const lastBuf = Buffer.allocUnsafe(lastLen);
      const lastPos = size - lastLen;
      await fd.read(lastBuf, 0, lastLen, lastPos);
      hash.update(lastBuf);
    }

    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}

// Recursively list all files under a directory and return detailed FileEntry objects.
// An unreadable root directory rejects; unreadable sub-directories and files are skipped.
export async function listFilesRecursive(
  rootDir: string,
  extensions?: string[],
  getHash: boolean = true,
  ignoreDirectories?: string[],
  onFile?: (filePath: string) => void,
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Normalize extensions to lowercase once for case-insensitive matching
  const normalizedExtensions = extensions?.map((ext) => ext.toLowerCase());

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (ex) {
      if (dir === rootDir) {
        throw ex;
      }
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ignoreDirectories && ignoreDirectories.includes(fullPath)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        onFile?.(fullPath);
        try {
          const info = await readFileInfo(fullPath, getHash);

          if (normalizedExtensions && normalizedExtensions.length > 0) {
            if (!normalizedExtensions.includes(info.extension.toLowerCase())) {
              continue;
            }
          }

          result.push(info);
        } catch {
          // skip files that cannot be read
        }
      }
    }
  }

  await walk(rootDir);

  return result;
}

// Recursively list all file paths under a directory without reading file metadata.
// An unreadable root directory rejects; unreadable sub-directories are skipped.
export async function listFilePathsRecursive(
  rootDir: string,
  ignoreDirectories?: string[],
  onFile?: (filePath: string) => void,
): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (ex) {
      if (dir === rootDir) {
        throw ex;
      }
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ignoreDirectories && ignoreDirectories.includes(fullPath)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        onFile?.(fullPath);
        result.push(fullPath);
      }
    }
  }

  await walk(rootDir);

  return result;
}
