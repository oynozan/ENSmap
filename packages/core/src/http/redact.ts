const MARKER = '[redacted]';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(text: string, secrets: readonly string[]): string {
  // Single pass, longest first, so the marker and longer secrets stay intact
  const alternatives = secrets
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (alternatives.length === 0) {
    return text;
  }
  return text.replace(new RegExp(alternatives.join('|'), 'g'), MARKER);
}
