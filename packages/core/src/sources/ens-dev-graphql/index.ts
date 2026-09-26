/*
 * graphql.ens.dev name source for the sepolia-v2 namespace.
 * schema.introspection.json is getIntrospectionQuery() against https://graphql.ens.dev, captured 2026-09-26.
 * The index holds only ENSv2 data, so children are listed by registry and a
 * parent without a subregistry has none, with no v1 `subdomains` branch.
 * Record history is supported. Resolver and link events are read by node
 * namehash, then AddressUpdated and default-record links by the contract
 * address of every resolver involved, since AddressUpdated's namehash is not
 * the node and is matched by resolver plus record id instead.
 */
export { createEnsDevGraphqlSource } from './adapter.ts';
