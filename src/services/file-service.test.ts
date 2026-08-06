import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, basename } from 'node:path';
import { fileExists, getHashEdges, listFilePathsRecursive, listFilesRecursive, readFileInfo } from './file-service';
import { createHash } from 'node:crypto';

async function makeTempDir(prefix = 'file-service-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function removeDirRecursive(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

async function createFile(root: string, relativePath: string, content: string): Promise<string> {
  const fullPath = join(root, relativePath);
  const dir = dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
}

describe('fileService functions', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
  });

  describe('fileExists', () => {
    it('returns true for an existing file and false for a missing one', async () => {
      const existing = await createFile(rootDir, 'exists.txt', 'hello');
      const missing = join(rootDir, 'missing.txt');

      await expect(fileExists(existing)).resolves.toBe(true);
      await expect(fileExists(missing)).resolves.toBe(false);
    });
  });

  describe('readFileInfo', () => {
    it('returns file info for an existing file', async () => {
      const filePath = await createFile(rootDir, 'images/sample.PNG', 'hello world');

      const info = await readFileInfo(filePath);

      const stats = await fs.stat(filePath);

      expect(info.filename).toBe(basename(filePath));
      expect(info.directory).toBe(dirname(filePath));
      expect(info.extension).toBe(extname(filePath));
      expect(info.size).toBe(stats.size);
      expect(info.birthtime).toBeInstanceOf(Date);
      expect(info.path).toBe(filePath);
    });

    it('can skip hash calculation when getHash is false', async () => {
      const filePath = await createFile(rootDir, 'images/nohash.png', 'content');

      const info = await readFileInfo(filePath, false);

      expect(info.hash).toBeUndefined();
    });

    it('throws when file does not exist', async () => {
      const nonExistent = join(rootDir, 'does-not-exist.png');
      await expect(readFileInfo(nonExistent)).rejects.toThrow();
    });
  });

  describe('getHashEdges', () => {
    function computeExpectedEdgeHash(content: Buffer | string, edgeSize: number): string {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const size = buf.length;
      const firstLen = Math.min(edgeSize, size);
      const lastLen = Math.min(edgeSize, Math.max(0, size - firstLen));

      const hash = createHash('sha256');

      if (firstLen > 0) {
        hash.update(buf.subarray(0, firstLen));
      }
      if (lastLen > 0) {
        const start = size - lastLen;
        hash.update(buf.subarray(start, start + lastLen));
      }

      return hash.digest('hex');
    }

    it('produces a deterministic hash for a small file (<16KB)', async () => {
      const content = 'small file content';
      const filePath = await createFile(rootDir, 'files/small.txt', content);

      const hash = await getHashEdges(filePath);
      expect(hash).toBe(computeExpectedEdgeHash(content, 16 * 1024));
    });

    it('produces different hashes for files with different content', async () => {
      const contentA = 'AAA'.repeat(1000);
      const contentB = 'BBB'.repeat(1000);
      const fileA = await createFile(rootDir, 'files/a.bin', contentA);
      const fileB = await createFile(rootDir, 'files/b.bin', contentB);

      const hashA = await getHashEdges(fileA);
      const hashB = await getHashEdges(fileB);

      expect(hashA).not.toBe(hashB);
    });

    it('handles large files by hashing only the first and last 16KB', async () => {
      const edgeSize = 16 * 1024;
      const totalSize = edgeSize * 3; // > 2 * EDGE_CHUNK_SIZE
      const buffer = Buffer.alloc(totalSize, 0);

      // Make first 16KB 'A', middle 16KB 'M', last 16KB 'Z'
      buffer.fill('A'.charCodeAt(0), 0, edgeSize);
      buffer.fill('M'.charCodeAt(0), edgeSize, 2 * edgeSize);
      buffer.fill('Z'.charCodeAt(0), 2 * edgeSize);

      const filePath = await createFile(rootDir, 'files/large.bin', buffer.toString('binary'));

      const expectedHash = (() => {
        const h = createHash('sha256');
        h.update(buffer.subarray(0, edgeSize));
        h.update(buffer.subarray(totalSize - edgeSize));
        return h.digest('hex');
      })();

      const actual = await getHashEdges(filePath);
      expect(actual).toBe(expectedHash);
    });

    it('throws when file does not exist', async () => {
      const nonExistent = join(rootDir, 'missing.bin');
      await expect(getHashEdges(nonExistent)).rejects.toThrow();
    });
  });

  describe('listFilesRecursive', () => {
    it('lists all files in nested directories', async () => {
      const file1 = await createFile(rootDir, 'a/photo1.jpg', 'one');
      const file2 = await createFile(rootDir, 'a/b/photo2.JPG', 'two');
      const file3 = await createFile(rootDir, 'c/note.txt', 'three');

      const files = await listFilesRecursive(rootDir);
      const paths = files.map((f) => join(f.directory, f.filename));

      expect(paths).toContain(file1);
      expect(paths).toContain(file2);
      expect(paths).toContain(file3);
    });

    it('filters by extensions in a case-insensitive way', async () => {
      const jpgLower = await createFile(rootDir, 'images/pic1.jpg', 'jpg-lower');
      const jpgUpper = await createFile(rootDir, 'images/pic2.JPG', 'jpg-upper');
      const pngMixed = await createFile(rootDir, 'images/pic3.PnG', 'png-mixed');
      await createFile(rootDir, 'images/readme.txt', 'text');

      const files = await listFilesRecursive(rootDir, ['.JPG', '.pNg']);
      const paths = files.map((f) => join(f.directory, f.filename));

      expect(paths).toContain(jpgLower);
      expect(paths).toContain(jpgUpper);
      expect(paths).toContain(pngMixed);
      expect(paths.length).toBe(3);
    });

    it('returns an empty array when no files match the given extensions', async () => {
      await createFile(rootDir, 'images/pic1.jpg', 'jpg-lower');

      const files = await listFilesRecursive(rootDir, ['.txt']);
      expect(files.length).toBe(0);
    });

    it('respects getHash=false and does not populate hash', async () => {
      const file1 = await createFile(rootDir, 'a/photo1.jpg', 'one');

      const files = await listFilesRecursive(rootDir, undefined, false);

      const match = files.find((f) => join(f.directory, f.filename) === file1)!;
      expect(match.hash).toBeUndefined();
    });

    it('continues walking when a directory cannot be read', async () => {
      // Create a subdirectory we will later make unreadable or delete
      const badDir = join(rootDir, 'bad');
      await fs.mkdir(badDir, { recursive: true });
      const goodFile = await createFile(rootDir, 'good/file.txt', 'ok');

      // Remove badDir so readdir throws ENOENT
      await fs.rmdir(badDir);

      const files = await listFilesRecursive(rootDir);
      const paths = files.map((f) => join(f.directory, f.filename));

      expect(paths).toContain(goodFile);
    });

    it('rejects when the root directory cannot be read', async () => {
      const missing = join(rootDir, 'missing-root');
      await expect(listFilesRecursive(missing)).rejects.toThrow();
    });
  });

  describe('listFilePathsRecursive', () => {
    it('returns all file paths in nested directories', async () => {
      const file1 = await createFile(rootDir, 'a/photo1.jpg', 'one');
      const file2 = await createFile(rootDir, 'a/b/photo2.JPG', 'two');
      const file3 = await createFile(rootDir, 'c/note.txt', 'three');

      const paths = await listFilePathsRecursive(rootDir);

      expect(paths.sort()).toEqual([file1, file2, file3].sort());
    });

    it('returns an empty array when there are no files', async () => {
      const paths = await listFilePathsRecursive(rootDir);
      expect(paths).toEqual([]);
    });

    it('skips ignored directories', async () => {
      const keep = await createFile(rootDir, 'a/keep.txt', 'keep');
      await createFile(rootDir, 'b/ignored/drop.txt', 'drop');

      const paths = await listFilePathsRecursive(rootDir, [join(rootDir, 'b', 'ignored')]);

      expect(paths).toEqual([keep]);
    });

    it('rejects when the root directory cannot be read', async () => {
      const missing = join(rootDir, 'missing-root');
      await expect(listFilePathsRecursive(missing)).rejects.toThrow();
    });
  });
});
