import {
  BalanceReservation,
  BalanceSnapshot,
  Employee,
  TimeOffRequest,
} from '@prisma/client';

import {
  BalanceReservationBuilder,
  BalanceSnapshotBuilder,
  EmployeeBuilder,
  TimeOffRequestBuilder,
} from '../builders';
import {
  HcmBalanceAdjustmentRequest,
  HcmBatchBalanceSnapshotRequest,
  buildHcmBalanceAdjustmentRequest,
  buildHcmBatchBalanceSnapshotRequest,
} from '../hcm/hcm-payload.builder';

export interface PendingTimeOffScenarioFixture {
  employee: Employee;
  manager: Employee;
  balanceSnapshot: BalanceSnapshot;
  request: TimeOffRequest;
  reservation: BalanceReservation;
}

export interface ApprovalScenarioFixture extends PendingTimeOffScenarioFixture {
  adjustmentRequest: HcmBalanceAdjustmentRequest;
}

export interface BatchSyncScenarioFixture {
  employee: Employee;
  balanceSnapshot: BalanceSnapshot;
  batchPayload: HcmBatchBalanceSnapshotRequest;
}

export function createPendingTimeOffScenarioFixture(): PendingTimeOffScenarioFixture {
  const manager = new EmployeeBuilder()
    .withId('mgr_sam')
    .withEmail('sam@example.com')
    .withDisplayName('Sam Patel')
    .withLocationId('loc_ny')
    .build();

  const employee = new EmployeeBuilder()
    .withId('emp_alice')
    .withEmail('alice@example.com')
    .withDisplayName('Alice Johnson')
    .withLocationId('loc_ny')
    .withManagerId(manager.id)
    .build();

  const balanceSnapshot = new BalanceSnapshotBuilder()
    .withEmployeeId(employee.id)
    .withLocationId(employee.locationId)
    .withAvailableUnits(8_000)
    .build();

  const request = new TimeOffRequestBuilder()
    .withId('req_alice_may')
    .withEmployeeId(employee.id)
    .withLocationId(employee.locationId)
    .withRequestedUnits(2_000)
    .build();

  const reservation = new BalanceReservationBuilder().fromRequest(request).build();

  return {
    employee,
    manager,
    balanceSnapshot,
    request,
    reservation,
  };
}

export function createApprovalScenarioFixture(): ApprovalScenarioFixture {
  const scenario = createPendingTimeOffScenarioFixture();
  const adjustmentRequest = buildHcmBalanceAdjustmentRequest({
    requestId: scenario.request.id,
    employeeId: scenario.employee.id,
    locationId: scenario.employee.locationId,
    deltaUnits: -scenario.request.requestedUnits,
  });

  return {
    ...scenario,
    adjustmentRequest,
  };
}

export function createBatchSyncScenarioFixture(): BatchSyncScenarioFixture {
  const employee = new EmployeeBuilder()
    .withId('emp_bob')
    .withEmail('bob@example.com')
    .withDisplayName('Bob Martinez')
    .withLocationId('loc_ny')
    .build();

  const balanceSnapshot = new BalanceSnapshotBuilder()
    .withEmployeeId(employee.id)
    .withLocationId(employee.locationId)
    .withAvailableUnits(12_000)
    .build();

  const batchPayload = buildHcmBatchBalanceSnapshotRequest({
    records: [
      {
        employeeId: employee.id,
        locationId: employee.locationId,
        availableUnits: balanceSnapshot.availableUnits,
        sourceVersion: balanceSnapshot.sourceVersion,
        sourceUpdatedAt: balanceSnapshot.sourceUpdatedAt.toISOString(),
      },
    ],
  });

  return {
    employee,
    balanceSnapshot,
    batchPayload,
  };
}

