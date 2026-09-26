import {
  buildClientSchema,
  GraphQLSchema,
  specifiedDirectives,
  type IntrospectionQuery,
} from 'graphql';

// Some servers list no directives yet still honour @include and @skip
export function loadClientSchema(intro: IntrospectionQuery): GraphQLSchema {
  const schema = buildClientSchema(intro);
  if (intro.__schema.directives.length > 0) {
    return schema;
  }
  return new GraphQLSchema({
    ...schema.toConfig(),
    directives: specifiedDirectives,
  });
}
