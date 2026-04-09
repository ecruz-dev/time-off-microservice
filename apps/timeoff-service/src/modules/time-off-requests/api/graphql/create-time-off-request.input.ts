import { Field, GraphQLISODateTime, ID, InputType, Int } from '@nestjs/graphql';

@InputType()
export class CreateTimeOffRequestInput {
  @Field(() => ID)
  locationId!: string;

  @Field(() => GraphQLISODateTime)
  startDate!: Date;

  @Field(() => GraphQLISODateTime)
  endDate!: Date;

  @Field(() => Int)
  requestedUnits!: number;

  @Field(() => String, { nullable: true })
  reason?: string | null;
}
