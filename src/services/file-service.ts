import { promises as fs } from 'node:fs';
import { dirname, extname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileEntry } from '../types/file-types';

const EDGE_CHUNK_SIZE = 16 * 1024; // 16KB

export const fileService = {
  async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },

  async readFileInfo(path: string, getHash: boolean = true): Promise<FileEntry> {
    const stats = await fs.stat(path);

    const size = stats.size;
    const directory = dirname(path);
    const extension = extname(path);
    const filename = basename(path);
    const birthtime = stats.birthtime;
    const hash = getHash ? await fileService.getHashEdges(path) : undefined;

    return {
      size,
      directory,
      extension,
      path,
      filename,
      birthtime,
      hash,
    };
  },

  async getHashEdges(path: string, algorithm: string = 'sha256'): Promise<string> {
    const fd = await fs.open(path, 'r');
    try {
      const stats = await fd.stat();
      const size = stats.size;

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
  },

  // Recursively list all files under a directory and return detailed FileEntry objects
  async listFilesRecursive(
    rootDir: string,
    extensions?: string[],
    getHash: boolean = true,
    ignoreDirectories?: string[],
  ): Promise<FileEntry[]> {
    const result: FileEntry[] = [];

    // Normalize extensions to lowercase once for case-insensitive matching
    const normalizedExtensions = extensions?.map((ext) => ext.toLowerCase());

    console.log('extensions to process = ', normalizedExtensions);

    async function walk(dir: string): Promise<void> {
      try {
        console.log('Walking directory: ', dir);
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            if (ignoreDirectories && ignoreDirectories.includes(fullPath)) {
              console.log(`Ignoring directory during file listing: ${fullPath}`);
              continue;
            }
            await walk(fullPath);
          } else if (entry.isFile()) {
            const info = await fileService.readFileInfo(fullPath, getHash);

            if (normalizedExtensions && normalizedExtensions.length > 0) {
              if (!normalizedExtensions.includes(info.extension.toLowerCase())) {
                continue;
              }

              console.log(`Reading file info for: ${fullPath}`);
            }

            result.push(info);
          }
        }
      } catch (ex) {
        if (dir === rootDir) {
          console.warn(`WARNING: could not read scan directory '${rootDir}':`, ex);
        } else {
          console.error('ERROR', ex);
        }
      }
    }

    await walk(rootDir);

    return result;
  },

  // Recursively list all file paths under a directory without reading file metadata
  async listFilePathsRecursive(rootDir: string, ignoreDirectories?: string[]): Promise<string[]> {
    const result: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            if (ignoreDirectories && ignoreDirectories.includes(fullPath)) {
              console.log(`Ignoring directory during file listing: ${fullPath}`);
              continue;
            }
            await walk(fullPath);
          } else if (entry.isFile()) {
            result.push(fullPath);
          }
        }
      } catch (ex) {
        console.error('!!! ERROR', ex);
      }
    }

    await walk(rootDir);

    return result;
  },
};
