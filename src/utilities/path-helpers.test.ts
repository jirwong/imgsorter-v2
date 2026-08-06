import { describe, it, expect } from 'vitest';
import { buildIgnoredSet, isIgnored, normalizePath } from './path-helpers';

describe('normalizePath', () => {
  it('lowercases the path', () => {
    expect(normalizePath('C:\\Temp\\Pics')).toBe('c:\\temp\\pics');
  });

  it('trims trailing forward slashes', () => {
    expect(normalizePath('/tmp/pics/')).toBe('/tmp/pics');
  });

  it('trims trailing backslashes', () => {
    expect(normalizePath('C:\\Temp\\')).toBe('c:\\temp');
  });

  it('leaves paths without trailing separators unchanged', () => {
    expect(normalizePath('C:\\Temp')).toBe('c:\\temp');
  });
});

describe('buildIgnoredSet', () => {
  it('normalizes every entry', () => {
    const set = buildIgnoredSet(['C:\\Temp\\', '/tmp/pics/']);
    expect(set).toEqual(new Set(['c:\\temp', '/tmp/pics']));
  });

  it('returns an empty set for an empty list', () => {
    expect(buildIgnoredSet([])).toEqual(new Set());
  });
});

describe('isIgnored', () => {
  it('matches case-insensitively', () => {
    const set = buildIgnoredSet(['C:\\Temp']);
    expect(isIgnored('c:\\temp', set)).toBe(true);
  });

  it('matches regardless of trailing separators', () => {
    const set = buildIgnoredSet(['C:\\Temp']);
    expect(isIgnored('C:\\Temp\\', set)).toBe(true);
  });

  it('returns false for paths outside the ignored set', () => {
    const set = buildIgnoredSet(['C:\\Temp']);
    expect(isIgnored('D:\\Other', set)).toBe(false);
  });
});
