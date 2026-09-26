import { readFileSync } from 'node:fs';

import { parse, validate, type IntrospectionQuery } from 'graphql';
import { describe, expect, it } from 'vitest';

import { loadClientSchema } from '../testing/schema.ts';
import {
  ADDR_EVENTS,
  CHILDREN,
  DOMAIN_BY_ID,
  RESOLVER_CHANGES,
} from './queries.ts';

const introspection = JSON.parse(
  readFileSync(new URL('schema.introspection.json', import.meta.url), 'utf8'),
) as IntrospectionQuery;

function errorsOf(intro: IntrospectionQuery, doc: string): string[] {
  return validate(loadClientSchema(intro), parse(doc)).map(
    (error) => error.message,
  );
}

describe('ens-subgraph query documents', () => {
  it.each([
    ['DomainById', DOMAIN_BY_ID],
    ['Children', CHILDREN],
    ['ResolverChanges', RESOLVER_CHANGES],
    ['AddrEvents', ADDR_EVENTS],
  ])('%s validates against the captured schema', (operation, doc) => {
    expect(doc).toContain(`query ${operation}(`);
    expect(errorsOf(introspection, doc)).toEqual([]);
  });
});

describe('loadClientSchema', () => {
  const DOC =
    'query Q($x: Boolean!) { domains @include(if: $x) { id } _meta @skip(if: $x) { deployment } }';

  it('restores the specified directives when the introspection lists none', () => {
    const bare = {
      __schema: { ...introspection.__schema, directives: [] },
    } satisfies IntrospectionQuery;

    expect(errorsOf(bare, DOC)).toEqual([]);
  });
});
