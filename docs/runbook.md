# Runbook

## Purpose

This runbook documents how to bootstrap, run, verify, and inspect the Time-Off microservice locally.

## Local Bootstrap

1. Install dependencies.

```bash
npm install
```

2. Generate Prisma client code.

```bash
npm run prisma:generate
```

3. Apply the committed migrations.

```bash
npm run prisma:migrate:deploy
```

4. Seed the local SQLite database.

```bash
npm run prisma:seed
```

## Seeded Data

The seed creates:

- employees `emp_alice`, `emp_bob`, and manager `mgr_sam`
- balance snapshots for `emp_alice` and `emp_bob` in `loc_ny`
- one pending request for `emp_alice`
- a matching active reservation
- one sample sync run
- one sample outbox event
- one sample audit log
- one completed idempotency record

Seed source: [seed.ts](c:/Users/developer/source/repos/timeoff-microservice/prisma/seed.ts)

## Starting Services

Start the mock HCM:

```bash
npm run start:dev:hcm-mock
```

Start the time-off service:

```bash
npm run start:dev:timeoff-service
```

Default local addresses:

- `http://127.0.0.1:3000` for `timeoff-service`
- `http://127.0.0.1:3001` for `hcm-mock`

## Smoke Checks

Health:

- `GET http://127.0.0.1:3000/health`
- `GET http://127.0.0.1:3001/health`

Realtime HCM balance:

- `GET http://127.0.0.1:3001/hcm/balances/emp_alice?locationId=loc_ny`

Batch pull into the time-off service:

- `POST http://127.0.0.1:3000/internal/hcm-sync/pull/balance-snapshots`
- required header: `x-internal-sync-token`

Process pending outbox work:

- `POST http://127.0.0.1:3000/internal/outbox/process`
- required header: `x-internal-sync-token`

Inspect request audit trail:

- `GET http://127.0.0.1:3000/internal/audit/requests/{requestId}`
- required header: `x-internal-sync-token`

## GraphQL Request Headers

Employee calls:

- `x-actor-id: emp_alice`
- `x-actor-role: EMPLOYEE`
- `idempotency-key: <unique-value>`

Manager calls:

- `x-actor-id: mgr_sam`
- `x-actor-role: MANAGER`
- `idempotency-key: <unique-value>`

## Common Workflows

### Create A Request

Send `createTimeOffRequest` to `/graphql` with employee headers.

Expected result:

- new `time_off_request` row with `PENDING`
- new active `balance_reservation`
- audit entry `TIME_OFF_REQUEST_CREATED`

### Approve A Request

Send `approveTimeOffRequest` to `/graphql` with manager headers.

Expected result on success:

- request moves to `APPROVED`
- reservation becomes `CONSUMED` if still active
- HCM balance is reduced

Expected result on transient HCM failure:

- request moves to `SYNC_FAILED`
- retry event is queued in `outbox_events`

### Reconciliation Drift

1. Use `POST /scenarios/drift` on `hcm-mock` to change available units.
2. Pull snapshots through `/internal/hcm-sync/pull/balance-snapshots`.
3. Inspect whether pending requests moved to `REQUIRES_REVIEW`.

## Verification Commands

Lint:

```bash
npm run lint
```

Unit and integration tests:

```bash
npm test
```

Service e2e:

```bash
npm run test:e2e:timeoff-service
```

Mock HCM e2e:

```bash
npm run test:e2e:hcm-mock
```

Coverage:

```bash
npm run test:coverage
```

Build:

```bash
npm run build
```

## Failure Triage

If GraphQL mutations fail:

- check actor headers and `idempotency-key`
- inspect request audit history through `/internal/audit/requests/:requestId`
- inspect queued retry events in `outbox_events`

If sync behavior looks wrong:

- inspect `/internal/audit/sync-runs/:syncRunId`
- verify `x-internal-sync-token`
- reset the mock HCM scenario state with `POST /scenarios/reset`

If local data is noisy during development:

- rerun the SQLite migration deploy command
- rerun the seed command
- or let the e2e suites recreate isolated SQLite files automatically

## Known Operational Notes

- The mock HCM supports forced one-time upstream errors through `/scenarios/force-next-adjustment-error`.
- Retry processing is explicit in local development through `/internal/outbox/process`; there is no background scheduler in this assessment version.
- Coverage is measured from the unit and integration Jest config. E2E tests are kept separate and documented as behavioral proof rather than included in line coverage numbers.
