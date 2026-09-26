import { describe, expect, it } from 'vitest';

import { nameHref, readNameParam } from './url.ts';

describe('readNameParam', () => {
  it('returns the trimmed name', () => {
    expect(readNameParam('?name=seller-a.eth')).toBe('seller-a.eth');
    expect(readNameParam('?name=%20gloomy.eth%20')).toBe('gloomy.eth');
  });

  it('returns null when the name is missing or blank', () => {
    expect(readNameParam('?name=%20')).toBeNull();
    expect(readNameParam('?name=')).toBeNull();
    expect(readNameParam('?x=1')).toBeNull();
    expect(readNameParam('')).toBeNull();
  });
});

describe('nameHref', () => {
  it('sets the name and keeps other params', () => {
    expect(nameHref('gloomy.eth', '/?x=1&name=a.eth')).toBe(
      '/?x=1&name=gloomy.eth',
    );
    expect(nameHref('gloomy.eth', '/')).toBe('/?name=gloomy.eth');
  });

  it('removes the name', () => {
    expect(nameHref(null, '/?name=a.eth')).toBe('/');
    expect(nameHref(null, '/?name=a.eth&x=1')).toBe('/?x=1');
  });

  it('round-trips a non-ASCII name through readNameParam', () => {
    const href = nameHref('❤.eth', '/');
    expect(href).not.toContain('❤');
    expect(readNameParam(href.slice(href.indexOf('?')))).toBe('❤.eth');
  });
});
