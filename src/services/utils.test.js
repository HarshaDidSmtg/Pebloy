// utils.test.js - Unit tests for utils.js
const { normalizeAuthType, normalizeSqlName } = require('./utils');

describe('normalizeAuthType', () => {
  it('returns Sql for sql input', () => {
    expect(normalizeAuthType('sql')).toBe('Sql');
    expect(normalizeAuthType('SQL')).toBe('Sql');
  });
  it('returns Windows for windows input', () => {
    expect(normalizeAuthType('windows')).toBe('Windows');
    expect(normalizeAuthType('WINDOWS')).toBe('Windows');
  });
  it('defaults to Windows', () => {
    expect(normalizeAuthType('')).toBe('Windows');
    expect(normalizeAuthType(null)).toBe('Windows');
    expect(normalizeAuthType(undefined)).toBe('Windows');
    expect(normalizeAuthType('other')).toBe('Windows');
  });
});

describe('normalizeSqlName', () => {
  it('removes brackets', () => {
    expect(normalizeSqlName('[dbo]')).toBe('dbo');
    expect(normalizeSqlName('[MyTable]')).toBe('MyTable');
  });
  it('trims whitespace', () => {
    expect(normalizeSqlName('  [dbo]  ')).toBe('dbo');
    expect(normalizeSqlName('Table')).toBe('Table');
  });
  it('returns empty string for null/undefined', () => {
    expect(normalizeSqlName(null)).toBe('');
    expect(normalizeSqlName(undefined)).toBe('');
  });
});
