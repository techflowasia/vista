import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('uses Vista identity for product chrome and generated artifacts', () => {
    expect(DEFAULT_BRAND.productName).toBe('Vista');
    expect(DEFAULT_BRAND.shortName).toBe('Vista');
    expect(DEFAULT_BRAND.markSrc).toBe('/openmaic-mark.png');
    expect(DEFAULT_BRAND.themeColor).toBe('#722ed1');
    expect(DEFAULT_BRAND.exportName).toBe('Vista');
    expect(DEFAULT_BRAND.description).not.toContain('OpenMAIC');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/logo-horizontal.png');
  });
});
