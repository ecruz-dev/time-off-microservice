# Time-Off Microservice

NestJS assessment workspace for a Time-Off microservice and a mock HCM integration service.

## What Is Included

- `apps/timeoff-service`: the primary service that owns request lifecycle, balance projection, reconciliation, retry handling, and operational audit endpoints
- `apps/hcm-mock`: a controllable mock HCM with realtime balance, batch snapshot, drift, and forced error scenarios
- `prisma/`: SQLite schema, migrations, and seed data
- `docs/TRD.md`: technical requirements and architecture decisions
- `docs/api-contracts.md`: GraphQL, REST, and outbox contracts
- `docs/runbook.md`: local setup and operating guide
- `docs/coverage-proof.md`: latest coverage command, output, and test inventory

## Architecture Summary

This repository implements one deployable Time-Off microservice inside a broader microservices context.

- Client-facing API: GraphQL on `/graphql`
- HCM integration: REST
- Persistence: Prisma with SQLite for the assessment
- Internal style: modular monolith with clear service boundaries
- Balance integrity model: authoritative HCM snapshot plus local pending reservations

Main modules in `timeoff-service`:

- `balances`: effective balance calculation and staleness rules
- `time-off-requests`: create, approve, reject, and state transitions
- `hcm-sync`: outbound HCM client and inbound batch sync endpoints
- `reconciliation`: drift detection and request flagging
- `outbox`: retry processing for failed HCM approval syncs
- `operational-audit`: immutable request and sync trail lookup

## Prerequisites

- Node.js 20+
- npm 10+

## Environment

Copy `.env.example` to `.env` if you want local overrides. Defaults are already wired for local development.

Important variables:

- `DATABASE_URL`
- `TIMEOFF_SERVICE_PORT`
- `HCM_MOCK_PORT`
- `HCM_BASE_URL`
- `HCM_INTERNAL_SYNC_TOKEN`
- `HCM_REQUEST_TIMEOUT_MS`
- `OUTBOX_BATCH_SIZE`
- `OUTBOX_MAX_ATTEMPTS`
- `OUTBOX_RETRY_BASE_DELAY_MS`

## Local Setup

Install dependencies:

```bash
npm install
```

Generate the Prisma client:

```bash
npm run prisma:generate
```

Apply migrations:

```bash
npm run prisma:migrate:deploy
```

Seed local data:

```bash
npm run prisma:seed
```

## Running The Apps

Start the mock HCM:

```bash
npm run start:dev:hcm-mock
```

Start the time-off service:

```bash
npm run start:dev:timeoff-service
```

Default URLs:

- `timeoff-service`: `http://127.0.0.1:3000`
- `hcm-mock`: `http://127.0.0.1:3001`

Health endpoints:

- `GET /health` on both apps

Internal operational endpoints on `timeoff-service`:

- `POST /internal/hcm-sync/balance-snapshots`
- `POST /internal/hcm-sync/pull/balance-snapshots`
- `POST /internal/outbox/process`
- `GET /internal/audit/requests/:requestId`
- `GET /internal/audit/sync-runs/:syncRunId`

These internal endpoints require the `x-internal-sync-token` header.

## GraphQL Usage

GraphQL runs at `/graphql`.

Employee mutations require:

- `x-actor-id`
- `x-actor-role: EMPLOYEE`
- `idempotency-key`

Manager review mutations require:

- `x-actor-id`
- `x-actor-role: MANAGER`
- `idempotency-key`

Example create request mutation:

```graphql
mutation CreateTimeOffRequest($input: CreateTimeOffRequestInput!) {
  createTimeOffRequest(input: $input) {
    id
    status
    employeeId
    locationId
    requestedUnits
  }
}
```

Example variables:

```json
{
  "input": {
    "locationId": "loc_ny",
    "startDate": "2026-05-11T00:00:00.000Z",
    "endDate": "2026-05-12T00:00:00.000Z",
    "requestedUnits": 2000,
    "reason": "Family trip"
  }
}
```

## Test Commands

Unit and integration tests:

```bash
npm test
```

`timeoff-service` e2e tests:

```bash
npm run test:e2e:timeoff-service
```

`hcm-mock` e2e tests:

```bash
npm run test:e2e:hcm-mock
```

Coverage:

```bash
npm run test:coverage
```

Build both apps:

```bash
npm run build
```

## Coverage And Proof

The current coverage command writes standard Jest artifacts under `coverage/`, including `coverage/lcov-report/index.html`.

The latest measured summary and the verification command set are documented in [docs/coverage-proof.md](docs/coverage-proof.md).

## Key Engineering Decisions

- HCM remains the source of truth for balances.
- ReadyOn keeps a local balance projection so employees get immediate feedback.
- Pending requests reserve balance locally to prevent oversubscription.
- Approval is HCM write-through. The request is not considered successfully approved until HCM accepts the deduction.
- Batch sync drift can move requests to `REQUIRES_REVIEW` if pending assumptions are no longer safe.
- Failed approval syncs are retried through a DB-backed outbox instead of adding a broker in v1.
- Audit logs are immutable and queryable through protected internal endpoints.

## References

- [TRD](docs/TRD.md)
- [API Contracts](docs/api-contracts.md)
- [Runbook](docs/runbook.md)
- [Coverage Proof](docs/coverage-proof.md)
