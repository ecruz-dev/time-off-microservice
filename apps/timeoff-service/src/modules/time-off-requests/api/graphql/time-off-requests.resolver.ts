import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CreateTimeOffRequestService } from '../../application/create-time-off-request.service';
import { RequestCreationError } from '../../application/request-creation.error';
import { requestCreationErrorCodes } from '../../application/request-creation.error';
import { ReviewTimeOffRequestService } from '../../application/review-time-off-request.service';
import { CreateTimeOffRequestInput } from './create-time-off-request.input';
import {
  GraphqlRequestContext,
  getIdempotencyKey,
  getRequestActor,
} from './graphql-request-context';
import { toGraphqlError } from './graphql-error.mapper';
import { ReviewTimeOffRequestInput } from './review-time-off-request.input';
import { TimeOffRequestGraphqlType } from './time-off-request.type';

@Resolver(() => TimeOffRequestGraphqlType)
export class TimeOffRequestsResolver {
  constructor(
    private readonly createTimeOffRequestService: CreateTimeOffRequestService,
    private readonly reviewTimeOffRequestService: ReviewTimeOffRequestService,
  ) {}

  @Query(() => String, { name: 'timeOffApiStatus' })
  timeOffApiStatus(): string {
    return 'ok';
  }

  @Mutation(() => TimeOffRequestGraphqlType)
  async createTimeOffRequest(
    @Args('input') input: CreateTimeOffRequestInput,
    @Context() context: GraphqlRequestContext,
  ) {
    try {
      const actor = getRequestActor(context);

      if (actor.role !== 'EMPLOYEE') {
        throw new RequestCreationError(
          requestCreationErrorCodes.forbidden,
          'Only employees can create time-off requests.',
        );
      }

      return await this.createTimeOffRequestService.execute({
        actorId: actor.actorId,
        idempotencyKey: getIdempotencyKey(context),
        locationId: input.locationId,
        startDate: input.startDate,
        endDate: input.endDate,
        requestedUnits: input.requestedUnits,
        reason: input.reason,
      });
    } catch (error) {
      throw toGraphqlError(error);
    }
  }

  @Mutation(() => TimeOffRequestGraphqlType)
  async approveTimeOffRequest(
    @Args('input') input: ReviewTimeOffRequestInput,
    @Context() context: GraphqlRequestContext,
  ) {
    return this.reviewRequest('APPROVE', input, context);
  }

  @Mutation(() => TimeOffRequestGraphqlType)
  async rejectTimeOffRequest(
    @Args('input') input: ReviewTimeOffRequestInput,
    @Context() context: GraphqlRequestContext,
  ) {
    return this.reviewRequest('REJECT', input, context);
  }

  private async reviewRequest(
    decision: 'APPROVE' | 'REJECT',
    input: ReviewTimeOffRequestInput,
    context: GraphqlRequestContext,
  ) {
    try {
      const actor = getRequestActor(context);

      if (actor.role !== 'MANAGER') {
        throw new RequestCreationError(
          requestCreationErrorCodes.forbidden,
          'Only managers can review time-off requests.',
        );
      }

      return await this.reviewTimeOffRequestService.execute({
        actorId: actor.actorId,
        decision,
        idempotencyKey: getIdempotencyKey(context),
        reason: input.reason,
        requestId: input.requestId,
      });
    } catch (error) {
      throw toGraphqlError(error);
    }
  }
}
