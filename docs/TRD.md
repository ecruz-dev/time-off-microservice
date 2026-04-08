# Time-Off Microservice TRD

## 1. Overview

This document defines the technical requirements and proposed design for a Time-Off Microservice built with NestJS, TypeScript, Prisma, and SQLite.

The service is the primary backend for employee time-off requests in ReadyOn, while the customer's HCM system remains the source of truth for balances and employment dimensions.

The core challenge is not only handling a time-off request lifecycle, but maintaining balance integrity while another external system can change those balances independently.

## 2. Problem Statement

Employees submit time-off requests in ReadyOn. Managers approve or reject them in ReadyOn. However:

- HCM owns the authoritative balance.
- HCM can be updated by systems other than ReadyOn.
- HCM exposes both realtime and batch integration patterns.
- HCM may reject invalid dimensions or insufficient balance, but the service must not rely on HCM being perfect.

The service must provide fast feedback to employees and valid approval workflows for managers without allowing local state to drift into an unsafe state.

## 3. Goals

- Provide a single service that owns the time-off request lifecycle.
- Expose a GraphQL API for employee and manager workflows.
- Integrate with HCM using REST for realtime reads/writes and batch synchronization.
- Preserve balance integrity even when HCM changes balances outside ReadyOn.
- Be defensive against HCM inconsistencies, outages, or missing validations.
- Support small, testable modules and a migration path from SQLite to Postgres.

## 4. Non-Goals

- Building payroll, accrual policy, or holiday-calculation engines.
- Replacing HCM as the source of truth for balances or employment master data.
- Splitting the solution into multiple internal deployable services in v1.
- Introducing a broker in the initial version.
- Supporting every HCM vendor contract in v1. The service will define an adapter boundary and one mock implementation.

## 5. Users and Primary Outcomes

### Employee

- View available time-off balance for a location.
- Submit a request and receive immediate feedback.
- See status changes for submitted requests.
- Cancel a pending request.

### Manager

- Review pending requests with confidence that balance data is recent enough to act on.
- Approve or reject requests.
- Understand when a request has drifted into a manual-review state because HCM changed independently.

### Integration / Platform

- Push batch balance snapshots from HCM into ReadyOn.
- Retry failed HCM interactions safely.
- Audit business and synchronization activity.

## 6. Constraints and Assumptions

- Stack: NestJS, TypeScript, Prisma, SQLite.
- API style: GraphQL for product-facing operations, REST for HCM integration.
- Balances are scoped by `employeeId + locationId`.
- The service does not own employee master data; it stores only identifiers needed for requests and balance projections.
- Authentication is assumed to be provided by an upstream identity layer or gateway. This service consumes role and identity claims.
- Balance values will be stored internally as integer minor units to avoid floating-point errors. For v1, `1000 units = 1 day`.
- HCM batch sync is authoritative for snapshot refreshes, but local reservations remain necessary to protect pending requests created inside ReadyOn.

## 7. Key Challenges

### 7.1 External Drift

HCM can change balances outside ReadyOn, for example during a work anniversary or start-of-year refresh.

### 7.2 Concurrent Requests

Two requests can race against the same balance. The service must prevent local oversubscription even if HCM has not yet been updated.

### 7.3 Partial Trust in HCM Validation

HCM may reject invalid requests, but the service cannot assume every invalid state will always be caught upstream.

### 7.4 Batch and Realtime Sync Coexistence

The service must handle realtime balance reads/writes and full snapshot imports without corrupting pending request logic.

### 7.5 Assessment Scope

The system should look production-minded without introducing unnecessary distributed complexity.

## 8. Proposed Architecture

### 8.1 External Architecture

The system is implemented as a single Time-Off Microservice within a larger distributed environment.

- Client-facing access is through GraphQL.
- HCM integration is via REST.
- The service owns its own database.
- HCM remains the authoritative source of truth for balances.

### 8.2 Internal Architecture

The service is a modular monolith.

- One deployable NestJS application.
- Strong module boundaries.
- Clean separation between API, application, domain, and infrastructure layers.

This choice preserves transactional integrity and keeps the assessment manageable while still leaving clear seams for future decomposition.

### 8.3 Why This Is Scalable

This design scales in the dimensions that matter for this problem:

- More request states and workflows can be added without rewriting the core model.
- More HCM adapters can be added behind a stable interface.
- SQLite can be swapped for Postgres with minimal domain-level change.
- Background processing can move from in-process jobs to dedicated workers later.
- Outbox events can be published to a broker later if multi-consumer integrations become necessary.

## 9. High-Level Solution

### 9.1 Source of Truth Strategy

HCM is authoritative for balance values. ReadyOn maintains a local projection for speed and resiliency.

The service stores:

- Latest known HCM balance snapshot per employee and location.
- Local reservations for pending requests created in ReadyOn.
- Time-off request lifecycle state.

Effective available balance is calculated as:

`effectiveAvailable = hcmSnapshotAvailable - pendingReservedUnits`

This allows the service to give instant feedback without trusting stale local data blindly.

### 9.2 Consistency Strategy

On request creation:

1. Validate request shape and actor permissions.
2. Load the local snapshot and pending reservations.
3. Refresh from HCM if the snapshot is stale or missing.
4. Defensively reject if effective balance is insufficient.
5. Persist the request and a matching reservation in one database transaction.

On approval:

1. Lock the request logically using idempotency and optimistic concurrency.
2. Re-read the latest balance or refresh from HCM if needed.
3. Ask HCM to commit the deduction.
4. Mark the request approved only after HCM succeeds.
5. Release or consume the reservation accordingly.

This avoids a local approval becoming authoritative before HCM accepts the final deduction.

### 9.3 Failure Strategy

- HCM timeout or transient failure: keep request in a retryable failure state.
- HCM rejects due to insufficient balance or invalid dimensions: move request to `REQUIRES_REVIEW` or reject depending on context.
- Batch sync changes balance materially while a request is pending: reservation remains, but approval must revalidate before commit.

## 10. Proposed Repository Structure

```text
timeoff-microservice/
  docs/
    TRD.md
    api-contracts.md

  apps/
    timeoff-service/
      src/
        main.ts
        app.module.ts
        config/
        common/
        modules/
          balances/
          time-off-requests/
          approvals/
          hcm-sync/
          reconciliation/
          audit/
          idempotency/
          health/
      test/
        e2e/

    hcm-mock/
      src/
        main.ts
        app.module.ts
        modules/
          balances/
          scenarios/
      test/
        e2e/

  libs/
    contracts/
    testing/

  prisma/
    schema.prisma
    migrations/
    seed.ts

  test/
    integration/
    contract/
    performance/
```

## 11. Module Responsibilities

### `balances`

- Balance snapshot read model.
- Effective balance calculation.
- Staleness policy.

### `time-off-requests`

- Request creation.
- Request queries.
- Reservation creation and release rules.

### `approvals`

- Manager approval and rejection workflows.
- Final HCM commit orchestration.

### `hcm-sync`

- HCM client.
- Batch sync ingestion endpoint.
- Snapshot upsert and sync tracking.

### `reconciliation`

- Drift detection.
- Recovery from sync conflicts and approval failures.

### `audit`

- Immutable business activity log.

### `idempotency`

- Duplicate request protection for mutating operations.

## 12. Data Model

### `balance_snapshots`

Stores the latest known HCM balance for an `employeeId + locationId`.

Key fields:

- `employee_id`
- `location_id`
- `available_units`
- `source_version`
- `source_updated_at`
- `last_synced_at`

### `balance_reservations`

Stores local holds for pending requests so two pending requests do not overspend the same balance locally.

Key fields:

- `request_id`
- `employee_id`
- `location_id`
- `reserved_units`
- `status`

### `time_off_requests`

Stores the business lifecycle of a time-off request.

Key fields:

- `id`
- `employee_id`
- `location_id`
- `requested_units`
- `status`
- `start_date`
- `end_date`
- `reason`
- `manager_decision_reason`
- `created_by`
- `approved_by`
- `version`

### `sync_runs`

Tracks inbound batch sync attempts and outcomes.

Key fields:

- `id`
- `source`
- `started_at`
- `completed_at`
- `status`
- `records_received`
- `records_applied`
- `error_summary`

### `outbox_events`

Stores internal events for reliable async processing and future external publication.

### `audit_logs`

Stores immutable audit entries for business and integration actions.

### `idempotency_keys`

Stores the request fingerprint and prior result for safe retry behavior.

## 13. Request Lifecycle

### Statuses

- `PENDING`
- `APPROVED`
- `REJECTED`
- `CANCELLED`
- `SYNC_FAILED`
- `REQUIRES_REVIEW`

### Transitions

- `PENDING -> APPROVED`
- `PENDING -> REJECTED`
- `PENDING -> CANCELLED`
- `PENDING -> SYNC_FAILED`
- `SYNC_FAILED -> APPROVED`
- `SYNC_FAILED -> REQUIRES_REVIEW`

`APPROVED`, `REJECTED`, and `CANCELLED` are terminal for v1.

## 14. Core Workflows

### 14.1 Balance Query

1. Resolve actor identity.
2. Read local snapshot and active reservations.
3. If snapshot is missing or stale, refresh from HCM.
4. Return authoritative snapshot, reserved units, and effective available units.

### 14.2 Create Request

1. Validate input and overlap rules.
2. Refresh balance if needed.
3. Calculate effective available units.
4. If sufficient, create request and reservation atomically.
5. Emit audit and outbox records.

### 14.3 Approve Request

1. Validate manager permissions.
2. Re-load current request state.
3. Re-check latest balance and dimensions defensively.
4. Send deduction to HCM with idempotency.
5. Update request to `APPROVED` and release reservation.

### 14.4 Reject or Cancel Request

1. Move request to terminal state.
2. Release reservation.
3. Emit audit and outbox records.

### 14.5 Batch Sync

1. Receive batch snapshot payload from HCM.
2. Store a `sync_run`.
3. Upsert balance snapshots.
4. Preserve reservations independently.
5. Flag requests that may require manual review because their assumptions have changed materially.

## 15. Security Considerations

- GraphQL requests require authenticated identity and role claims.
- Employee-facing operations must bind to the authenticated employee identity, not caller-provided employee IDs.
- Manager mutations require role-based authorization.
- HCM inbound sync endpoints must be protected with a machine-to-machine secret or signed requests.
- Mutating operations should require or strongly support idempotency keys.
- Validation errors must not leak internal implementation details.
- Logs and audit entries must avoid sensitive payload spillage.

## 16. Reliability and Operational Considerations

- Use database transactions for request creation and reservation writes.
- Use optimistic concurrency via version fields on mutable records.
- Keep a database-backed outbox for retries and future async integrations.
- Expose health/readiness endpoints.
- Attach correlation IDs to logs, HCM calls, and audit records.
- Record sync failures explicitly rather than silently swallowing them.

## 17. Alternatives Considered

### 17.1 Multiple Internal Microservices

Rejected for v1. It would introduce distributed consistency and deployment overhead without clear benefit for the assessment scope.

### 17.2 REST-Only Client API

Rejected. GraphQL better fits the position requirements and reduces client round trips for combined balance and request data.

### 17.3 Always Read and Write Directly to HCM With No Local Projection

Rejected. It would make the UI slower, increase coupling to HCM availability, and make local concurrency protection much weaker.

### 17.4 Message Broker in v1

Rejected. A broker is not required for the current scope. A database-backed outbox provides enough reliability while keeping local development and testing simple.

### 17.5 Event-Sourced Ledger as Primary Model

Rejected for v1. It is powerful, but too heavy for the assessment. Snapshot plus reservation modeling is sufficient and easier to explain and verify.

## 18. Risks and Mitigations

### Risk: HCM changes balance after request creation but before approval

Mitigation: Revalidate on approval and allow `REQUIRES_REVIEW` when drift makes automatic approval unsafe.

### Risk: Duplicate create or approve calls

Mitigation: Idempotency keys plus version checks on mutable records.

### Risk: Batch sync overwrites assumptions used by pending requests

Mitigation: Keep reservations separate from snapshots and trigger reconciliation checks after sync.

### Risk: SQLite hides production scaling constraints

Mitigation: Keep repository interfaces thin and model the schema in a way that can move to Postgres later.

## 19. Open Questions

- Should the service support partial-day requests beyond the chosen minor-unit precision in v1?
- Where will manager hierarchy come from in production: token claims, gateway enrichment, or a separate directory service?
- Are overlapping requests allowed if only one remains pending at a time?
- Should cancellation of an approved request trigger a compensating write back to HCM in v1 or later?

## 20. Initial Delivery Plan

1. Finalize contracts and test strategy.
2. Scaffold Nest workspace and mock HCM app.
3. Add Prisma schema and seed data.
4. Implement balances and reservations.
5. Implement request creation and approval workflows.
6. Add sync, reconciliation, retries, and auditability.
