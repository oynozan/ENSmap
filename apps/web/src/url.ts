const NAME_PARAM = 'name';

export function readNameParam(search: string): string | null {
  const name = new URLSearchParams(search).get(NAME_PARAM)?.trim();
  return name === undefined || name === '' ? null : name;
}

export function nameHref(name: string | null, current: string): string {
  // The base only lets URL parse a relative path; it never leaves this function.
  const url = new URL(current, 'http://localhost');
  if (name === null) {
    url.searchParams.delete(NAME_PARAM);
  } else {
    url.searchParams.set(NAME_PARAM, name);
  }
  return url.pathname + url.search;
}
