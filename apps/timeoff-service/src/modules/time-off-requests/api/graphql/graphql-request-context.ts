import { GraphQLError } from 'graphql';

export interface GraphqlRequestContext {
  req?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

export interface RequestActor {
  actorId: string;
  role: string;
}

export function getRequestActor(context: GraphqlRequestContext): RequestActor {
  const headers = context.req?.headers ?? {};
  const actorIdHeader = headers['x-actor-id'];
  const actorRoleHeader = headers['x-actor-role'];
  const actorId = Array.isArray(actorIdHeader) ? actorIdHeader[0] : actorIdHeader;
  const role = Array.isArray(actorRoleHeader)
    ? actorRoleHeader[0]
    : actorRoleHeader ?? 'EMPLOYEE';

  if (!actorId?.trim()) {
    throw new GraphQLError('Authentication is required.', {
      extensions: {
        code: 'UNAUTHENTICATED',
      },
    });
  }

  return {
    actorId: actorId.trim(),
    role: role.trim().toUpperCase(),
  };
}

export function getIdempotencyKey(context: GraphqlRequestContext): string {
  const headers = context.req?.headers ?? {};
  const keyHeader = headers['idempotency-key'];
  const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;

  if (!key?.trim()) {
    throw new GraphQLError('Idempotency-Key header is required.', {
      extensions: {
        code: 'BAD_USER_INPUT',
      },
    });
  }

  return key.trim();
}
