import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { COLORS, FONTS } from './theme.ts';

// Read from disk: Vitest stubs CSS imports, ?raw included, to an empty string.
const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

function customProperty(name: string): string | undefined {
  return new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

describe('theme tokens', () => {
  it('has the exact palette and fonts', () => {
    expect(COLORS).toEqual({
      ground: '#191919',
      bone: '#e6e3dc',
      ash: '#9a9894',
      line: '#6a6a6a',
      sage: '#8fc1a9',
      coral: '#e08a7a',
    });
    expect(FONTS).toEqual({
      display: "'Lexend Deca Variable', sans-serif",
      ui: "'Manrope Variable', sans-serif",
    });
  });

  it.each(Object.entries(COLORS))(
    'theme.css --%s matches COLORS',
    (token, value) => {
      expect(customProperty(token)).toBe(value);
    },
  );

  it('theme.css font properties match FONTS', () => {
    expect(customProperty('font-display')).toBe(FONTS.display);
    expect(customProperty('font-ui')).toBe(FONTS.ui);
  });
});
