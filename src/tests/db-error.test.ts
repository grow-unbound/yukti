import { describe, expect, it } from 'vitest';
import { describeDbError } from '@/lib/db-error';

describe('describeDbError', () => {
  it('passes plain messages through', () => {
    expect(describeDbError({ message: 'boom' })).toBe('boom');
  });

  it('collapses gateway HTML to a short stable string', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>supabase.co | 522: Connection timed out</title></head><body>ray 123</body></html>';
    expect(describeDbError({ message: html })).toBe('upstream gateway error (supabase.co | 522: Connection timed out)');
  });

  it('handles HTML without a title and missing errors', () => {
    expect(describeDbError({ message: '<html></html>' })).toBe('upstream gateway error');
    expect(describeDbError(null)).toBe('unknown error');
    expect(describeDbError({ message: '', code: '57014' })).toBe('57014');
  });
});
