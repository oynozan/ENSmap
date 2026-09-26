export const PAGE_SIZE = 1000;
// The index fails an `or` of 31 or more filters (probed 2026-09-26)
export const MAX_OR_FILTERS = 25;
export const ZERO_NODE = `0x${'0'.repeat(64)}`;

const DOMAIN_FIELDS = `id name labelName labelhash canonicalId protocol
    owner { id } resolver { address } resolvedAddress { id }
    subregistry { address } parent { id subregistry { address } }
    registrationDate createdAt expiryDate`;

const EVENT_FIELDS = 'id blockNumber timestamp type data';

export const DOMAIN_BY_ID = `query DomainById($id: String!) {
  domain(id: $id) {
    ${DOMAIN_FIELDS}
  }
}`;

export const REGISTRY_CHILDREN = `query RegistryChildren($registry: String!, $after: String) {
  domainConnection(first: ${PAGE_SIZE}, after: $after, where: { registry: $registry }) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        ${DOMAIN_FIELDS}
      }
    }
  }
}`;

export const REFERRERS = `query Referrers($address: String!) {
  registry(address: $address) {
    referencedBy { name }
  }
}`;

// ResolverUpdated data carries a token id, so namehash tells the nodes apart
export const NODE_HISTORY = `query NodeHistory($nodes: [EventFilter!]!) {
  events(
    first: ${PAGE_SIZE}
    where: { type_in: ["Linked", "ResolverUpdated"], or: $nodes }
  ) {
    ${EVENT_FIELDS} namehash
  }
}`;

// Linked on the empty-name node sets the record every unlinked node reads
export const RESOLVER_HISTORY = `query ResolverHistory($resolvers: [EventFilter!]!) {
  addressUpdates: events(
    first: ${PAGE_SIZE}
    where: { type: "AddressUpdated", or: $resolvers }
  ) {
    ${EVENT_FIELDS}
  }
  defaultLinks: events(
    first: ${PAGE_SIZE}
    where: { type: "Linked", namehash: "${ZERO_NODE}", or: $resolvers }
  ) {
    ${EVENT_FIELDS}
  }
}`;
