import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class ReviewTimeOffRequestInput {
  @Field(() => ID)
  requestId!: string;

  @Field(() => String, { nullable: true })
  reason?: string | null;
}
