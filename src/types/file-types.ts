export type FileEntry = {
  size: number;
  directory: string;
  extension: string;
  path: string;
  filename: string;
  birthtime: Date;
  hash?: string;
};

export type FileRecord = {
  filename: string;
  hash: string;
  count: number;
  extension: string;
  directories: string;
  size: number;
};
