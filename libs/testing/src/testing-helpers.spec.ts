import {
  EmployeeBuilder,
  TestClock,
  buildAcceptedHcmBalanceAdjustmentResponse,
  buildHcmBalanceAdjustmentRequest,
  buildHcmBatchBalanceSnapshotRequest,
  createApprovalScenarioFixture,
  createBatchSyncScenarioFixture,
  createPendingTimeOffScenarioFixture,
  resetTestSequences,
} from './index';

describe('testing helpers', () => {
  beforeEach(() => {
    resetTestSequences();
  });

  it('builds employee data with predictable overrides', () => {
    const employee = new EmployeeBuilder()
      .withId('emp_custom')
      .withEmail('custom@example.com')
      .withLocationId('loc_sf')
      .inactive()
      .build();

    const createInput = new EmployeeBuilder()
      .withId('emp_custom')
      .withEmail('custom@example.com')
      .withLocationId('loc_sf')
      .inactive()
      .toCreateInput();

    expect(employee).toMatchObject({
      id: 'emp_custom',
      email: 'custom@example.com',
      locationId: 'loc_sf',
      isActive: false,
    });
    expect(createInput).toMatchObject({
      id: 'emp_custom',
      email: 'custom@example.com',
      locationId: 'loc_sf',
      isActive: false,
    });
  });

  it('creates a consistent pending request fixture', () => {
    const scenario = createPendingTimeOffScenarioFixture();

    expect(scenario.employee.managerId).toBe(scenario.manager.id);
    expect(scenario.balanceSnapshot.employeeId).toBe(scenario.employee.id);
    expect(scenario.request.employeeId).toBe(scenario.employee.id);
    expect(scenario.request.locationId).toBe(scenario.employee.locationId);
    expect(scenario.reservation.requestId).toBe(scenario.request.id);
    expect(scenario.reservation.reservedUnits).toBe(
      scenario.request.requestedUnits,
    );
  });

  it('creates approval and batch sync fixtures aligned with HCM contracts', () => {
    const approvalScenario = createApprovalScenarioFixture();
    const batchSyncScenario = createBatchSyncScenarioFixture();

    expect(approvalScenario.adjustmentRequest).toMatchObject({
      requestId: approvalScenario.request.id,
      employeeId: approvalScenario.employee.id,
      locationId: approvalScenario.employee.locationId,
      deltaUnits: -approvalScenario.request.requestedUnits,
      reasonCode: 'TIME_OFF_APPROVAL',
    });
    expect(batchSyncScenario.batchPayload.records[0]).toMatchObject({
      employeeId: batchSyncScenario.employee.id,
      locationId: batchSyncScenario.employee.locationId,
      availableUnits: batchSyncScenario.balanceSnapshot.availableUnits,
    });
  });

  it('supports advancing a mock clock deterministically', () => {
    const clock = new TestClock(new Date('2026-04-08T10:00:00.000Z'));

    clock.advanceByMinutes(30).advanceBySeconds(15).advanceByDays(1);

    expect(clock.now().toISOString()).toBe('2026-04-09T10:30:15.000Z');
  });

  it('builds HCM payloads with override-friendly defaults', () => {
    const adjustmentRequest = buildHcmBalanceAdjustmentRequest({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      deltaUnits: -1000,
    });
    const acceptedResponse = buildAcceptedHcmBalanceAdjustmentResponse({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 7000,
    });
    const batchPayload = buildHcmBatchBalanceSnapshotRequest({
      records: [acceptedResponse],
    });

    expect(adjustmentRequest).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      deltaUnits: -1000,
    });
    expect(acceptedResponse).toMatchObject({
      accepted: true,
      employeeId: 'emp_alice',
      availableUnits: 7000,
    });
    expect(batchPayload.records).toHaveLength(1);
    expect(batchPayload.records[0]).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 7000,
    });
  });
});
