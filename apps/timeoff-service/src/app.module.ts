import { Module } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';

import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { HcmSyncModule } from './modules/hcm-sync/hcm-sync.module';
import { TimeOffRequestsModule } from './modules/time-off-requests/time-off-requests.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: '/graphql',
      sortSchema: true,
    }),
    DatabaseModule,
    HealthModule,
    HcmSyncModule,
    TimeOffRequestsModule,
  ],
})
export class AppModule {}
