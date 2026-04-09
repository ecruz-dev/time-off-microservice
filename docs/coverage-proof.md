# Coverage Proof

## Verification Date

- 2026-04-09

## Commands Used

Unit and integration suite:

```bash
npm test
```

Coverage run:

```bash
npm run test:coverage
```

`timeoff-service` end-to-end suite:

```bash
npm run test:e2e:timeoff-service
```

`hcm-mock` end-to-end suite:

```bash
npm run test:e2e:hcm-mock
```

Workspace build:

```bash
npm run build
```

## Latest Coverage Output

From `npm run test:coverage`:

```text
Statements   : 40.85% ( 757/1853 )
Branches     : 33.21% ( 184/554 )
Functions    : 43.95% ( 171/389 )
Lines        : 40.44% ( 728/1800 )
```

Coverage artifacts are written to:

- `coverage/lcov-report/index.html`
- `coverage/lcov.info`

## What The Coverage Represents

The coverage command uses the unit and integration Jest config in [jest-unit.json](c:/Users/developer/source/repos/timeoff-microservice/test/jest-unit.json).

Included:

- domain logic
- application services
- repository-backed integration tests
- shared testing helpers

Excluded from line coverage by config:

- `*.module.ts`
- `*.controller.ts`
- `main.ts`

Not included in the coverage percentage:

- `timeoff-service` e2e tests
- `hcm-mock` e2e tests

That separation is intentional. The coverage percentage shows unit and integration depth, while the e2e suites prove the full workflows against real Nest applications and a live mock HCM.

## Current Test Inventory

Unit and integration:

- balance domain calculations
- request creation
- request review and approval
- reconciliation logic
- outbox retry processor
- SQLite-backed service integration tests
- shared testing builders and fixtures

E2E:

- GraphQL request creation
- approval and rejection flows
- HCM sync pull and push flows
- drift reconciliation
- outbox retry and audit lookup
- health checks for both apps
- mock HCM contract and scenario controls

## Notes On Interpretation

The percentage is not optimized to be as high as possible by excluding code aggressively. It still includes a broad cross-section of application code, including modules that are exercised mostly through higher-level tests.

For this assessment, the stronger signal is the combination of:

- unit coverage around balance and workflow invariants
- integration coverage around Prisma-backed persistence
- e2e coverage around GraphQL, REST, reconciliation, retry, and idempotency behavior
