# Time-Off Microservice API Contracts

## 1. Conventions

- Product-facing API uses GraphQL.
- HCM integration uses REST over HTTP.
- Mutating operations require an `Idempotency-Key` header.
- Numeric balance values are exposed as integer `units`.
- For v1, `1000 units = 1 day`.
- Timestamps are ISO 8601 UTC.

## 2. GraphQL Contract

### Scalars

```graphql
scalar Date
scalar DateTime
```

### Enums

```graphql
enum TimeOffRequestStatus {
  PENDING
  APPROVED
  REJECTED
  CANCELLED
  SYNC_FAILED
  REQUIRES_REVIEW
}
```

### Types

```graphql
type TimeOffBalance {
  employeeId: ID!
  locationId: ID!
  availableUnits: Int!
  reservedUnits: Int!
  effectiveAvailableUnits: Int!
  sourceUpdatedAt: DateTime
  lastSyncedAt: DateTime
  stale: Boolean!
}

type TimeOffRequest {
  id: ID!
  employeeId: ID!
  locationId: ID!
  startDate: Date!
  endDate: Date!
  requestedUnits: Int!
  reason: String
  status: TimeOffRequestStatus!
  managerDecisionReason: String
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

### Inputs

```graphql
input CreateTimeOffRequestInput {
  locationId: ID!
  startDate: Date!
  endDate: Date!
  requestedUnits: Int!
  reason: String
}

input ReviewTimeOffRequestInput {
  requestId: ID!
  reason: String
}
```

### Queries

```graphql
type Query {
  myTimeOffBalance(locationId: ID!): TimeOffBalance!
  myTimeOffRequests(status: [TimeOffRequestStatus!]): [TimeOffRequest!]!
  pendingApprovalRequests(locationId: ID): [TimeOffRequest!]!
}
```

### Mutations

```graphql
type Mutation {
  createTimeOffRequest(input: CreateTimeOffRequestInput!): TimeOffRequest!
  cancelTimeOffRequest(requestId: ID!): TimeOffRequest!
  approveTimeOffRequest(input: ReviewTimeOffRequestInput!): TimeOffRequest!
  rejectTimeOffRequest(input: ReviewTimeOffRequestInput!): TimeOffRequest!
}
```

## 3. Authorization Rules

- `myTimeOffBalance`, `myTimeOffRequests`, `createTimeOffRequest`, and `cancelTimeOffRequest` are employee-scoped and derive `employeeId` from the authenticated context.
- `pendingApprovalRequests`, `approveTimeOffRequest`, and `rejectTimeOffRequest` require a manager role.
- Managers can act only on requests within authorized locations or reporting scope.

## 4. GraphQL Error Codes

- `BAD_USER_INPUT`
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `INSUFFICIENT_BALANCE`
- `INVALID_DIMENSIONS`
- `UPSTREAM_HCM_FAILURE`
- `IDEMPOTENCY_REPLAY`

## 5. HCM REST Contract

The real HCM API is abstracted behind an adapter. The mock HCM used in tests will implement the following contract.

### 5.1 Read Balance

`GET /hcm/balances/{employeeId}?locationId={locationId}`

Response:

```json
{
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "availableUnits": 10000,
  "sourceVersion": "2026-04-08T14:10:30Z#42",
  "sourceUpdatedAt": "2026-04-08T14:10:30Z"
}
```

### 5.2 Apply Balance Adjustment

`POST /hcm/balance-adjustments`

Request:

```json
{
  "idempotencyKey": "9e8db1cb-26f6-4d36-87c8-5b57f84f8d1a",
  "requestId": "req_123",
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "deltaUnits": -2000,
  "reasonCode": "TIME_OFF_APPROVAL",
  "occurredAt": "2026-04-08T14:15:00Z"
}
```

Success response:

```json
{
  "accepted": true,
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "availableUnits": 8000,
  "sourceVersion": "2026-04-08T14:15:00Z#43",
  "sourceUpdatedAt": "2026-04-08T14:15:00Z"
}
```

Failure response:

```json
{
  "accepted": false,
  "code": "INSUFFICIENT_BALANCE",
  "message": "Available balance is lower than requested deduction."
}
```

### 5.3 Push Batch Snapshot to ReadyOn

The HCM system sends a full balance corpus to the Time-Off Microservice.

`POST /internal/hcm-sync/balance-snapshots`

Request:

```json
{
  "runId": "sync_2026_04_08_01",
  "sentAt": "2026-04-08T15:00:00Z",
  "records": [
    {
      "employeeId": "emp_123",
      "locationId": "loc_ny",
      "availableUnits": 8000,
      "sourceVersion": "2026-04-08T14:15:00Z#43",
      "sourceUpdatedAt": "2026-04-08T14:15:00Z"
    }
  ]
}
```

Response:

```json
{
  "runId": "sync_2026_04_08_01",
  "status": "ACCEPTED",
  "recordsReceived": 1
}
```

## 6. Internal Error Envelope for REST Endpoints

```json
{
  "code": "INVALID_SIGNATURE",
  "message": "The request signature is invalid.",
  "correlationId": "corr_123"
}
```

## 7. Outbox Event Contracts

These events are stored in the database-backed outbox in v1. They can later be published to a broker without changing the domain contract.

### `timeoff.request.created.v1`

```json
{
  "eventType": "timeoff.request.created.v1",
  "requestId": "req_123",
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "requestedUnits": 2000,
  "occurredAt": "2026-04-08T14:12:00Z"
}
```

### `timeoff.request.approved.v1`

```json
{
  "eventType": "timeoff.request.approved.v1",
  "requestId": "req_123",
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "requestedUnits": 2000,
  "approvedBy": "mgr_9",
  "occurredAt": "2026-04-08T14:15:05Z"
}
```

### `timeoff.request.rejected.v1`

```json
{
  "eventType": "timeoff.request.rejected.v1",
  "requestId": "req_123",
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "rejectedBy": "mgr_9",
  "reason": "Coverage unavailable",
  "occurredAt": "2026-04-08T14:15:05Z"
}
```

### `balance.snapshot.updated.v1`

```json
{
  "eventType": "balance.snapshot.updated.v1",
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "availableUnits": 8000,
  "sourceVersion": "2026-04-08T14:15:00Z#43",
  "occurredAt": "2026-04-08T15:00:00Z"
}
```

### `balance.reconciliation.flagged.v1`

```json
{
  "eventType": "balance.reconciliation.flagged.v1",
  "employeeId": "emp_123",
  "locationId": "loc_ny",
  "reason": "Snapshot changed materially while request was pending",
  "occurredAt": "2026-04-08T15:00:03Z"
}
```
