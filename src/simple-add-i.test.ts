import { describe, it, expect } from 'vitest';
import { addI } from './simple-add-i';

describe('addI', () => {
  it('adds two positive numbers', () => {
    expect(addI(2, 3)).toBe(5);
  });

  it('adds a positive and negative number', () => {
    expect(addI(10, -4)).toBe(6);
  });

  it('adds zero', () => {
    expect(addI(7, 0)).toBe(7);
  });

  it('adds 2+2=4', () => {
    expect(addI(2, 2)).toBe(4);
  });
});
