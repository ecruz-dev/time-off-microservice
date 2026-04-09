import { GraphQLError } from 'graphql';

import {
  RequestCreationError,
  requestCreationErrorCodes,
} from '../../application/request-creation.error';

export function toGraphqlError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) {
    return error;
  }

  if (error instanceof RequestCreationError) {
    return new GraphQLError(error.message, {
      extensions: {
        code: error.code,
      },
    });
  }

  return new GraphQLError('Unexpected error.', {
    extensions: {
      code: requestCreationErrorCodes.conflict,
    },
  });
}
