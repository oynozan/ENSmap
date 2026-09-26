export const PAGE_SIZE = 1000;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const DOMAIN_FIELDS = `id name labelName labelhash parent { id } owner { id }
    registrant { id } wrappedOwner { id } resolver { address }
    resolvedAddress { id } createdAt expiryDate
    registration { registrationDate expiryDate }`;

export const DOMAIN_BY_ID = `query DomainById($id: ID!) {
  domain(id: $id) {
    ${DOMAIN_FIELDS}
  }
}`;

// Owner 0x0 with no resolver is a deleted subname, so it is not listed
export const CHILDREN = `query Children($parents: [String!]!, $after: ID!) {
  domains(
    first: ${PAGE_SIZE}
    orderBy: id
    orderDirection: asc
    where: {
      and: [
        { parent_in: $parents }
        { id_gt: $after }
        { or: [{ owner_not: "${ZERO_ADDRESS}" }, { resolver_not: null }] }
      ]
    }
  ) {
    ${DOMAIN_FIELDS}
  }
}`;

// A cleared NewResolver points at no Resolver entity, so it gets its own alias
export const RESOLVER_CHANGES = `query ResolverChanges($ids: [String!]!, $afterSet: ID!, $afterCleared: ID!) {
  set: newResolvers(
    first: ${PAGE_SIZE}
    orderBy: id
    where: {
      and: [
        { domain_in: $ids }
        { resolver_not: "${ZERO_ADDRESS}" }
        { id_gt: $afterSet }
      ]
    }
  ) {
    id
    blockNumber
    domain { id }
    resolver { address }
  }
  cleared: newResolvers(
    first: ${PAGE_SIZE}
    orderBy: id
    where: {
      and: [
        { domain_in: $ids }
        { resolver: "${ZERO_ADDRESS}" }
        { id_gt: $afterCleared }
      ]
    }
  ) {
    id
    blockNumber
    domain { id }
  }
}`;

export const ADDR_EVENTS = `query AddrEvents($resolverIds: [String!]!) {
  addrChangeds(
    where: { resolver_in: $resolverIds }
    orderBy: blockNumber
    orderDirection: desc
    first: ${PAGE_SIZE}
  ) {
    id
    blockNumber
    resolver { id address }
    addr { id }
  }
  multicoinAddrChangeds(
    where: { coinType: 60, resolver_in: $resolverIds }
    orderBy: blockNumber
    orderDirection: desc
    first: ${PAGE_SIZE}
  ) {
    id
    blockNumber
    resolver { id address }
    addr
  }
  versionChangeds(
    where: { resolver_in: $resolverIds }
    orderBy: blockNumber
    orderDirection: desc
    first: ${PAGE_SIZE}
  ) {
    id
    blockNumber
    resolver { id address }
  }
}`;
