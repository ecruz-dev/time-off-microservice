import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { TimeOffRequestStatus } from '@prisma/client';

registerEnumType(TimeOffRequestStatus, {
  name: 'TimeOffRequestStatus',
});

@ObjectType('TimeOffRequest')
export class TimeOffRequestGraphqlType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  employeeId!: string;

  @Field(() => ID)
  locationId!: string;

  @Field(() => GraphQLISODateTime)
  startDate!: Date;

  @Field(() => GraphQLISODateTime)
  endDate!: Date;

  @Field(() => Int)
  requestedUnits!: number;

  @Field(() => String, { nullable: true })
  reason!: string | null;

  @Field(() => TimeOffRequestStatus)
  status!: TimeOffRequestStatus;

  @Field(() => String, { nullable: true })
  managerDecisionReason!: string | null;

  @Field(() => ID, { nullable: true })
  approvedBy!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}
