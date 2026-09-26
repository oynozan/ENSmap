import { ens_beautify, ens_normalize } from '@adraffy/ens-normalize';
import { describe, expect, it } from 'vitest';

import {
  beautifyName,
  childName,
  compareLabels,
  firstLabel,
  interpretLabel,
  isEncodedLabel,
  isResolvable,
  nameDepth,
  nameId,
  parseNameInput,
  type InterpretedName,
} from './names.ts';

const HASH = 'ab'.repeat(32);

describe('parseNameInput', () => {
  it('normalizes case and splits labels', () => {
    const result = parseNameInput('Nick.ETH');
    expect(result).toEqual({ ok: true, name: 'nick.eth' });
  });

  it('reports the ENSIP-15 reason per invalid label', () => {
    const result = parseNameInput('a_b.x:y.eth');
    expect(result).toEqual({
      ok: false,
      errors: [
        { index: 0, label: 'a_b', reason: 'underscore allowed only at start' },
        { index: 1, label: 'x:y', reason: 'disallowed character' },
      ],
    });
  });

  it('accepts an encoded label in any case and stores it lowercase', () => {
    const result = parseNameInput(`[${HASH.toUpperCase()}].eth`);
    expect(result).toEqual({ ok: true, name: `[${HASH}].eth` });
  });

  it('rejects empty input with an empty-label reason', () => {
    expect(parseNameInput('')).toEqual({
      ok: false,
      errors: [{ index: 0, label: '', reason: 'empty label' }],
    });
  });

  it('rejects a leading empty label the same way', () => {
    expect(parseNameInput('.eth')).toEqual({
      ok: false,
      errors: [{ index: 0, label: '', reason: 'empty label' }],
    });
  });

  it('normalizes an emoji label, distinct from its beautified form', () => {
    const result = parseNameInput('❤.eth');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.name).toBe(ens_normalize('❤.eth'));
    expect(beautifyName(result.name)).toBe(ens_beautify('❤.eth'));
    expect(beautifyName(result.name)).not.toBe(result.name);
  });
});

describe('beautifyName', () => {
  it('leaves an encoded label unchanged', () => {
    const result = parseNameInput(`[${HASH}].eth`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(beautifyName(result.name)).toBe(`[${HASH}].eth`);
  });
});

describe('interpretLabel', () => {
  const labelhash: `0x${string}` = `0x${HASH}`;

  it('falls back to the bracketed labelhash for a non-normalized label', () => {
    expect(interpretLabel('Amazon', labelhash)).toBe(`[${HASH}]`);
  });

  it('falls back to the bracketed labelhash when normalization throws', () => {
    expect(interpretLabel('a:b', labelhash)).toBe(`[${HASH}]`);
  });

  it('falls back to the bracketed labelhash for null input', () => {
    expect(interpretLabel(null, labelhash)).toBe(`[${HASH}]`);
  });

  it('returns the raw label when it is already normalized', () => {
    expect(interpretLabel('amazon', labelhash)).toBe('amazon');
  });

  it('falls back to the bracketed labelhash for an empty label', () => {
    expect(interpretLabel('', labelhash)).toBe(`[${HASH}]`);
  });

  it('falls back to the bracketed labelhash for a label containing a dot', () => {
    expect(interpretLabel('a.b', labelhash)).toBe(`[${HASH}]`);
  });

  it('lowercases a mixed-case labelhash in the placeholder', () => {
    const mixed: `0x${string}` = `0xAB${'cd'.repeat(31)}`;

    expect(interpretLabel(null, mixed)).toBe(`[ab${'cd'.repeat(31)}]`);
  });
});

describe('childName', () => {
  const parent = 'eth' as InterpretedName;

  it('prefixes a normalized label onto the parent name', () => {
    expect(childName('sub', parent)).toBe('sub.eth');
  });

  it('lowercases an encoded label', () => {
    expect(childName(`[${HASH.toUpperCase()}]`, parent)).toBe(`[${HASH}].eth`);
  });

  it('throws for a label that is neither normalized nor encoded', () => {
    expect(() => childName('Sub', parent)).toThrow();
    expect(() => childName('a:b', parent)).toThrow();
  });
});

describe('isResolvable', () => {
  it('is false when any label is encoded', () => {
    const result = parseNameInput(`[${HASH}].eth`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(isResolvable(result.name)).toBe(false);
  });

  it('is true when every label is normalized', () => {
    const result = parseNameInput('nick.eth');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(isResolvable(result.name)).toBe(true);
  });
});

describe('nameDepth', () => {
  it('counts the labels', () => {
    expect(nameDepth('a.b.eth' as InterpretedName)).toBe(3);
  });
});

describe('firstLabel', () => {
  it('returns the label before the first dot', () => {
    expect(firstLabel('a.b.eth' as InterpretedName)).toBe('a');
  });
});

describe('isEncodedLabel', () => {
  it('accepts 64 hex characters in brackets, in any case', () => {
    expect(isEncodedLabel(`[${HASH}]`)).toBe(true);
    expect(isEncodedLabel(`[${HASH.toUpperCase()}]`)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isEncodedLabel('nick')).toBe(false);
    expect(isEncodedLabel(`[${HASH.slice(1)}]`)).toBe(false);
    expect(isEncodedLabel(HASH)).toBe(false);
  });
});

describe('compareLabels', () => {
  it('compares by Unicode code point, not UTF-16 code unit', () => {
    expect(compareLabels('ｚ', '𝒜')).toBeLessThan(0);
  });

  it('orders equal strings as equal', () => {
    expect(compareLabels('abc', 'abc')).toBe(0);
  });
});

describe('nameId', () => {
  it('is viem namehash', () => {
    expect(nameId('ens.eth')).toBe(
      '0x4e34d3a81dc3a20f71bbdf2160492ddaa17ee7e5523757d47153379c13cb46df',
    );
  });
});
