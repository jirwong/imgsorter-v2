import { describe, it, expect } from 'vitest';
import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('returns the message for an Error instance', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('oops')).toBe('oops');
    expect(errorMessage(42)).toBe('42');
  });
});
