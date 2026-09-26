import { readFileSync } from 'node:fs';

import { parse, validate, type IntrospectionQuery } from 'graphql';
import { describe, expect, it } from 'vitest';

import { loadClientSchema } from '../testing/schema.ts';
import {
  DOMAIN_BY_ID,
  NODE_HISTORY,
  REFERRERS,
  REGISTRY_CHILDREN,
  RESOLVER_HISTORY,
} from './queries.ts';

const introspection = JSON.parse(
  readFileSync(new URL('schema.introspection.json', import.meta.url), 'utf8'),
) as IntrospectionQuery;

describe('ens-dev-graphql query documents', () => {
  it.each([
    ['DomainById', DOMAIN_BY_ID],
    ['RegistryChildren', REGISTRY_CHILDREN],
    ['Referrers', REFERRERS],
    ['NodeHistory', NODE_HISTORY],
    ['ResolverHistory', RESOLVER_HISTORY],
  ])('%s validates against the captured schema', (operation, doc) => {
    expect(doc).toContain(`query ${operation}(`);
    expect(
      validate(loadClientSchema(introspection), parse(doc)).map(
        (error) => error.message,
      ),
    ).toEqual([]);
  });
});
