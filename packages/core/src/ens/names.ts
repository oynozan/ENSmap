import { ens_beautify, ens_normalize, ens_split } from '@adraffy/ens-normalize';
import { namehash, type Hex } from 'viem';

export type { Hex };

// Branded so only parseNameInput or childName output can carry this type
export type InterpretedName = string & { readonly __brand: 'InterpretedName' };

export interface NameLabelError {
  index: number;
  label: string;
  reason: string;
}

export type ParseNameResult =
  { ok: true; name: InterpretedName } | { ok: false; errors: NameLabelError[] };

// [<64 hex>] is the ENSIP-15 placeholder for a label that isn't normalized
const ENCODED_LABEL_PATTERN = /^\[[0-9a-f]{64}\]$/i;

export function isEncodedLabel(label: string): boolean {
  return ENCODED_LABEL_PATTERN.test(label);
}

// Reason is the message text before the first colon, not String(error)'s prefix
function labelErrorReason(error: Error): string {
  return (error.message.split(':')[0] ?? error.message).trim();
}

export function parseNameInput(raw: string): ParseNameResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {
      ok: false,
      errors: [{ index: 0, label: '', reason: 'empty label' }],
    };
  }

  const rawLabels = trimmed.split('.');
  const errors: NameLabelError[] = [];
  const labels: string[] = [];

  rawLabels.forEach((label, index) => {
    if (isEncodedLabel(label)) {
      labels.push(label.toLowerCase());
      return;
    }
    // ens_split('') returns [] instead of an empty-label error, so handle it directly
    if (label === '') {
      errors.push({ index, label, reason: 'empty label' });
      return;
    }
    const split = ens_split(label)[0];
    if (split === undefined) {
      errors.push({ index, label, reason: 'empty label' });
      return;
    }
    if (split.error) {
      errors.push({ index, label, reason: labelErrorReason(split.error) });
      return;
    }
    labels.push(String.fromCodePoint(...(split.output ?? [])));
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, name: labels.join('.') as InterpretedName };
}

export function interpretLabel(raw: string | null, labelhash: Hex): string {
  const placeholder = `[${labelhash.slice(2).toLowerCase()}]`;
  // ens_normalize accepts both, but neither is a single label
  if (raw === null || raw === '' || raw.includes('.')) {
    return placeholder;
  }
  try {
    return ens_normalize(raw) === raw ? raw : placeholder;
  } catch {
    return placeholder;
  }
}

export function childName(
  label: string,
  parent: InterpretedName,
): InterpretedName {
  if (isEncodedLabel(label)) {
    return `${label.toLowerCase()}.${parent}` as InterpretedName;
  }
  let normalized: string;
  try {
    normalized = ens_normalize(label);
  } catch (error) {
    throw new Error(`label is not normalized or encoded: ${label}`, {
      cause: error,
    });
  }
  if (normalized !== label) {
    throw new Error(`label is not normalized or encoded: ${label}`);
  }
  return `${label}.${parent}` as InterpretedName;
}

export function beautifyName(n: InterpretedName): string {
  return n
    .split('.')
    .map((label) => (isEncodedLabel(label) ? label : ens_beautify(label)))
    .join('.');
}

export function nameDepth(n: InterpretedName): number {
  return n.split('.').length;
}

export function firstLabel(n: InterpretedName): string {
  return n.split('.')[0] ?? '';
}

export function isResolvable(n: InterpretedName): boolean {
  return !n.split('.').some(isEncodedLabel);
}

// Compares Unicode code points, unlike '<' or localeCompare, which compare UTF-16 units
export function compareLabels(a: string, b: string): number {
  const aCps = Array.from(a, (ch) => ch.codePointAt(0) ?? 0);
  const bCps = Array.from(b, (ch) => ch.codePointAt(0) ?? 0);
  const length = Math.min(aCps.length, bCps.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (aCps[i] ?? 0) - (bCps[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return aCps.length - bCps.length;
}

export const nameId: (name: string) => Hex = namehash;
