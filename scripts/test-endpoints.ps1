[CmdletBinding()]
param(
  [string]$TimeoffBaseUrl,
  [string]$HcmBaseUrl,
  [string]$InternalSyncToken,
  [string]$EmployeeId = 'emp_alice',
  [string]$LocationId = 'loc_ny',
  [string]$ManagerId = 'mgr_sam',
  [switch]$SkipReset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultEnvFile = Join-Path $repoRoot '.env'
$defaultEnvExampleFile = Join-Path $repoRoot '.env.example'

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()

    if (-not $line -or $line.StartsWith('#')) {
      continue
    }

    $separatorIndex = $line.IndexOf('=')

    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $line.Substring(0, $separatorIndex).Trim()

    if ($key -ne $Name) {
      continue
    }

    $value = $line.Substring($separatorIndex + 1).Trim()

    if (
      $value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'")))
    ) {
      return $value.Substring(1, $value.Length - 2)
    }

    return $value
  }

  return $null
}

function Resolve-ConfigValue {
  param(
    [string]$ExplicitValue,
    [Parameter(Mandatory = $true)]
    [string]$EnvName,
    [Parameter(Mandatory = $true)]
    [string]$Fallback
  )

  if ($ExplicitValue) {
    return $ExplicitValue
  }

  $envValue = Get-DotEnvValue -Path $defaultEnvFile -Name $EnvName

  if ($envValue) {
    return $envValue
  }

  $exampleValue = Get-DotEnvValue -Path $defaultEnvExampleFile -Name $EnvName

  if ($exampleValue) {
    return $exampleValue
  }

  return $Fallback
}

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host "PASS: $Message" -ForegroundColor Green
}

function Assert-Condition {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Condition) {
    throw "Assertion failed: $Message"
  }
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "Assertion failed: $Message. Expected '$Expected' but got '$Actual'."
  }
}

function Assert-CollectionContains {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$Collection,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedValue,
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if ($Collection -notcontains $ExpectedValue) {
    $renderedCollection = if ($Collection.Count -eq 0) { '<empty>' } else { ($Collection -join ', ') }
    throw "Assertion failed: $Message. Missing '$ExpectedValue'. Current values: $renderedCollection"
  }
}

function Get-OptionalPropertyValue {
  param(
    [Parameter(Mandatory = $true)]$InputObject,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $InputObject) {
    return $null
  }

  $property = $InputObject.PSObject.Properties[$Name]

  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [hashtable]$Headers = @{},
    $Body = $null
  )

  Write-Host "$Method $Uri" -ForegroundColor DarkGray

  $requestParameters = @{
    Method      = $Method
    Uri         = $Uri
    Headers     = $Headers
    ErrorAction = 'Stop'
  }

  if ($null -ne $Body) {
    $requestParameters['ContentType'] = 'application/json'
    $requestParameters['Body'] = ($Body | ConvertTo-Json -Depth 10)
  }

  return Invoke-RestMethod @requestParameters
}

function Invoke-GraphqlRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Query,
    $Variables,
    [hashtable]$Headers = @{}
  )

  $response = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedTimeoffBaseUrl/graphql" `
    -Headers $Headers `
    -Body @{
      query = $Query
      variables = $Variables
    }

  $errors = Get-OptionalPropertyValue -InputObject $response -Name 'errors'

  if ($null -ne $errors) {
    $errorJson = $errors | ConvertTo-Json -Depth 10
    throw "GraphQL returned errors: $errorJson"
  }

  $data = Get-OptionalPropertyValue -InputObject $response -Name 'data'
  Assert-Condition -Condition ($null -ne $data) -Message 'GraphQL response did not include a data payload.'

  return $data
}

function Get-AuditActions {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$AuditEntries
  )

  return @($AuditEntries | ForEach-Object { $_.action })
}

function New-EmployeeHeaders {
  param([Parameter(Mandatory = $true)][string]$IdempotencyKey)

  return @{
    'Content-Type'   = 'application/json'
    'x-actor-id'     = $EmployeeId
    'x-actor-role'   = 'EMPLOYEE'
    'idempotency-key' = $IdempotencyKey
  }
}

function New-ManagerHeaders {
  param([Parameter(Mandatory = $true)][string]$IdempotencyKey)

  return @{
    'Content-Type'   = 'application/json'
    'x-actor-id'     = $ManagerId
    'x-actor-role'   = 'MANAGER'
    'idempotency-key' = $IdempotencyKey
  }
}

function New-InternalHeaders {
  return @{
    'Content-Type'          = 'application/json'
    'x-internal-sync-token' = $script:ResolvedInternalSyncToken
  }
}

$script:ResolvedTimeoffBaseUrl = Resolve-ConfigValue `
  -ExplicitValue $TimeoffBaseUrl `
  -EnvName 'TIMEOFF_BASE_URL' `
  -Fallback 'http://127.0.0.1:3000'

$script:ResolvedHcmBaseUrl = Resolve-ConfigValue `
  -ExplicitValue $HcmBaseUrl `
  -EnvName 'HCM_BASE_URL' `
  -Fallback 'http://127.0.0.1:3001'

$script:ResolvedInternalSyncToken = Resolve-ConfigValue `
  -ExplicitValue $InternalSyncToken `
  -EnvName 'HCM_INTERNAL_SYNC_TOKEN' `
  -Fallback 'local-dev-internal-sync-token'

$runToken = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$internalHeaders = New-InternalHeaders

$createMutation = @'
mutation CreateTimeOffRequest($input: CreateTimeOffRequestInput!) {
  createTimeOffRequest(input: $input) {
    id
    employeeId
    locationId
    requestedUnits
    status
    reason
    createdAt
    updatedAt
  }
}
'@

$approveMutation = @'
mutation ApproveTimeOffRequest($input: ReviewTimeOffRequestInput!) {
  approveTimeOffRequest(input: $input) {
    id
    status
    approvedBy
    managerDecisionReason
    updatedAt
  }
}
'@

$rejectMutation = @'
mutation RejectTimeOffRequest($input: ReviewTimeOffRequestInput!) {
  rejectTimeOffRequest(input: $input) {
    id
    status
    managerDecisionReason
    updatedAt
  }
}
'@

$statusQuery = @'
query {
  timeOffApiStatus
}
'@

$summary = [ordered]@{
  timeoffBaseUrl           = $script:ResolvedTimeoffBaseUrl
  hcmBaseUrl               = $script:ResolvedHcmBaseUrl
  initialSyncRunId         = $null
  pullSyncRunId            = $null
  approveRequestId         = $null
  rejectRequestId          = $null
  retryRequestId           = $null
  driftRequestId           = $null
  driftSyncRunId           = $null
  recoverySyncRunId        = $null
}

try {
  Write-Step "Configuration"
  Write-Host "timeoff-service: $script:ResolvedTimeoffBaseUrl"
  Write-Host "hcm-mock: $script:ResolvedHcmBaseUrl"
  Write-Host "employeeId: $EmployeeId"
  Write-Host "managerId: $ManagerId"
  Write-Host "locationId: $LocationId"

  Write-Step "Health checks"
  $timeoffHealth = Invoke-JsonRequest -Method 'GET' -Uri "$script:ResolvedTimeoffBaseUrl/health"
  $hcmHealth = Invoke-JsonRequest -Method 'GET' -Uri "$script:ResolvedHcmBaseUrl/health"
  Assert-Condition -Condition ($null -ne $timeoffHealth) -Message 'timeoff-service health endpoint did not return a payload.'
  Assert-Condition -Condition ($null -ne $hcmHealth) -Message 'hcm-mock health endpoint did not return a payload.'
  Write-Pass "Both services are reachable."

  Write-Step "Reset and inspect mock HCM state"
  if (-not $SkipReset) {
    $resetState = Invoke-JsonRequest -Method 'POST' -Uri "$script:ResolvedHcmBaseUrl/scenarios/reset"
    Assert-Condition -Condition ($null -ne $resetState) -Message 'Mock HCM reset did not return state.'
    Write-Pass "Mock HCM state reset."
  }

  $scenarioState = Invoke-JsonRequest -Method 'GET' -Uri "$script:ResolvedHcmBaseUrl/scenarios/state"
  Assert-Condition -Condition ($null -ne $scenarioState) -Message 'Scenario state endpoint returned no payload.'

  $updatedScenarioState = Invoke-JsonRequest `
    -Method 'PATCH' `
    -Uri "$script:ResolvedHcmBaseUrl/scenarios/settings" `
    -Body @{
      enforceDimensionValidationErrors = $true
      enforceInsufficientBalanceErrors = $true
    }
  Assert-Condition `
    -Condition ($updatedScenarioState.settings.enforceDimensionValidationErrors -eq $true) `
    -Message 'Dimension validation setting was not applied.'
  Assert-Condition `
    -Condition ($updatedScenarioState.settings.enforceInsufficientBalanceErrors -eq $true) `
    -Message 'Insufficient balance validation setting was not applied.'
  Write-Pass "Scenario settings are at the expected defaults."

  Write-Step "Read realtime and batch HCM balances"
  $aliceBalance = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balances/${EmployeeId}?locationId=${LocationId}"
  Assert-Equal -Actual $aliceBalance.employeeId -Expected $EmployeeId -Message 'Unexpected employee returned from HCM balance endpoint'
  Assert-Equal -Actual $aliceBalance.locationId -Expected $LocationId -Message 'Unexpected location returned from HCM balance endpoint'
  Assert-Equal -Actual $aliceBalance.availableUnits -Expected 8000 -Message 'Mock HCM seeded balance does not match the expected baseline'

  $batchSnapshotResponse = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balance-snapshots"
  Assert-Condition -Condition (@($batchSnapshotResponse.records).Count -ge 1) -Message 'Mock HCM batch endpoint returned no records.'
  Write-Pass "Realtime and batch HCM endpoints returned seeded balances."

  Write-Step "Import an initial batch snapshot into timeoff-service"
  $initialSyncRun = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/hcm-sync/balance-snapshots" `
    -Headers $internalHeaders `
    -Body @{
      runId = "powershell-initial-sync-$runToken"
      sentAt = (Get-Date).ToUniversalTime().ToString('o')
      records = @($batchSnapshotResponse.records)
    }
  $summary.initialSyncRunId = $initialSyncRun.syncRunId
  Assert-Equal -Actual $initialSyncRun.status -Expected 'COMPLETED' -Message 'Initial internal batch import did not complete'
  Assert-Condition -Condition ($initialSyncRun.recordsApplied -ge 1) -Message 'Initial internal batch import did not apply any records.'

  $initialSyncAudit = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/audit/sync-runs/$($summary.initialSyncRunId)" `
    -Headers $internalHeaders
  $initialSyncActions = Get-AuditActions -AuditEntries @($initialSyncAudit)
  Assert-CollectionContains `
    -Collection $initialSyncActions `
    -ExpectedValue 'HCM_BALANCE_BATCH_SYNC_COMPLETED' `
    -Message 'Initial sync audit trail did not contain the batch completion action'
  Write-Pass "Initial snapshot import and audit lookup succeeded."

  Write-Step "Smoke test the internal pull sync endpoint"
  $pullSyncResponse = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/hcm-sync/pull/balance-snapshots" `
    -Headers $internalHeaders `
    -Body @{}
  $summary.pullSyncRunId = $pullSyncResponse.syncRunId
  Assert-Condition `
    -Condition (($pullSyncResponse.status -eq 'COMPLETED') -or ($pullSyncResponse.reusedExistingRun -eq $true)) `
    -Message 'Pull sync endpoint did not return a completed or reused-existing run response.'
  Write-Pass "Internal pull sync endpoint responded successfully."

  Write-Step "Check GraphQL API health"
  $graphqlStatus = Invoke-GraphqlRequest -Query $statusQuery -Variables @{} -Headers @{
    'Content-Type' = 'application/json'
  }
  Assert-Equal -Actual $graphqlStatus.timeOffApiStatus -Expected 'ok' -Message 'GraphQL API status query did not return ok'
  Write-Pass "GraphQL API status is healthy."

  Write-Step "Create and replay a pending time-off request"
  $approveCreateKey = "powershell-create-approve-$runToken"
  $approveCreateInput = @{
    input = @{
      locationId = $LocationId
      startDate = '2026-06-10T00:00:00.000Z'
      endDate = '2026-06-11T00:00:00.000Z'
      requestedUnits = 50
      reason = 'PowerShell smoke approval flow'
    }
  }
  $createdForApproval = Invoke-GraphqlRequest `
    -Query $createMutation `
    -Variables $approveCreateInput `
    -Headers (New-EmployeeHeaders -IdempotencyKey $approveCreateKey)
  $createdForApprovalReplay = Invoke-GraphqlRequest `
    -Query $createMutation `
    -Variables $approveCreateInput `
    -Headers (New-EmployeeHeaders -IdempotencyKey $approveCreateKey)
  $summary.approveRequestId = $createdForApproval.createTimeOffRequest.id
  Assert-Equal -Actual $createdForApproval.createTimeOffRequest.status -Expected 'PENDING' -Message 'Created request was not left in PENDING'
  Assert-Equal -Actual $createdForApprovalReplay.createTimeOffRequest.id -Expected $summary.approveRequestId -Message 'Idempotent replay returned a different request id'
  Write-Pass "Create mutation and idempotent replay behaved correctly."

  Write-Step "Approve a request as a manager"
  $approvedRequest = Invoke-GraphqlRequest `
    -Query $approveMutation `
    -Variables @{
      input = @{
        requestId = $summary.approveRequestId
        reason = 'Approved from PowerShell'
      }
    } `
    -Headers (New-ManagerHeaders -IdempotencyKey "powershell-approve-$runToken")
  Assert-Equal -Actual $approvedRequest.approveTimeOffRequest.status -Expected 'APPROVED' -Message 'Approved request did not transition to APPROVED'
  Assert-Equal -Actual $approvedRequest.approveTimeOffRequest.approvedBy -Expected $ManagerId -Message 'Approved request did not record the manager id'

  $balanceAfterApproval = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balances/${EmployeeId}?locationId=${LocationId}"
  Assert-Equal -Actual $balanceAfterApproval.availableUnits -Expected 7950 -Message 'HCM balance after approval did not reflect the approved deduction'
  Write-Pass "Approval flow updated both timeoff-service and HCM."

  Write-Step "Create and reject a request"
  $rejectRequest = Invoke-GraphqlRequest `
    -Query $createMutation `
    -Variables @{
      input = @{
        locationId = $LocationId
        startDate = '2026-06-15T00:00:00.000Z'
        endDate = '2026-06-16T00:00:00.000Z'
        requestedUnits = 40
        reason = 'PowerShell smoke rejection flow'
      }
    } `
    -Headers (New-EmployeeHeaders -IdempotencyKey "powershell-create-reject-$runToken")
  $summary.rejectRequestId = $rejectRequest.createTimeOffRequest.id
  Assert-Equal -Actual $rejectRequest.createTimeOffRequest.status -Expected 'PENDING' -Message 'Rejection test request was not created as PENDING'

  $rejectedRequest = Invoke-GraphqlRequest `
    -Query $rejectMutation `
    -Variables @{
      input = @{
        requestId = $summary.rejectRequestId
        reason = 'Rejected from PowerShell'
      }
    } `
    -Headers (New-ManagerHeaders -IdempotencyKey "powershell-reject-$runToken")
  Assert-Equal -Actual $rejectedRequest.rejectTimeOffRequest.status -Expected 'REJECTED' -Message 'Rejected request did not transition to REJECTED'

  $balanceAfterRejection = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balances/${EmployeeId}?locationId=${LocationId}"
  Assert-Equal -Actual $balanceAfterRejection.availableUnits -Expected 7950 -Message 'HCM balance changed after rejecting a request'
  Write-Pass "Rejection flow released the request without touching HCM balance."

  Write-Step "Force an HCM write-through failure and verify outbox retry"
  $null = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedHcmBaseUrl/scenarios/force-next-adjustment-error" `
    -Body @{
      code = 'UPSTREAM_TIMEOUT'
      message = 'The mock HCM is simulating a transient outage.'
    }

  $retryCreateRequest = Invoke-GraphqlRequest `
    -Query $createMutation `
    -Variables @{
      input = @{
        locationId = $LocationId
        startDate = '2026-06-20T00:00:00.000Z'
        endDate = '2026-06-21T00:00:00.000Z'
        requestedUnits = 30
        reason = 'PowerShell smoke retry flow'
      }
    } `
    -Headers (New-EmployeeHeaders -IdempotencyKey "powershell-create-retry-$runToken")
  $summary.retryRequestId = $retryCreateRequest.createTimeOffRequest.id

  $syncFailedApproval = Invoke-GraphqlRequest `
    -Query $approveMutation `
    -Variables @{
      input = @{
        requestId = $summary.retryRequestId
        reason = 'Approve and let outbox retry'
      }
    } `
    -Headers (New-ManagerHeaders -IdempotencyKey "powershell-approve-retry-$runToken")
  Assert-Equal -Actual $syncFailedApproval.approveTimeOffRequest.status -Expected 'SYNC_FAILED' -Message 'Approval did not move to SYNC_FAILED when HCM forced an error'

  $requestAuditBeforeRetry = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/audit/requests/$($summary.retryRequestId)" `
    -Headers $internalHeaders
  $requestActionsBeforeRetry = Get-AuditActions -AuditEntries @($requestAuditBeforeRetry)
  Assert-CollectionContains `
    -Collection $requestActionsBeforeRetry `
    -ExpectedValue 'TIME_OFF_REQUEST_SYNC_FAILED' `
    -Message 'Request audit trail did not record the sync failure'
  Assert-CollectionContains `
    -Collection $requestActionsBeforeRetry `
    -ExpectedValue 'TIME_OFF_REQUEST_SYNC_RETRY_ENQUEUED' `
    -Message 'Request audit trail did not record the retry enqueue'

  $outboxProcessResponse = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/outbox/process" `
    -Headers $internalHeaders `
    -Body @{
      limit = 25
    }
  Assert-Condition -Condition ($outboxProcessResponse.processed -ge 1) -Message 'Outbox processor did not handle any pending events.'

  $requestAuditAfterRetry = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/audit/requests/$($summary.retryRequestId)" `
    -Headers $internalHeaders
  $requestActionsAfterRetry = Get-AuditActions -AuditEntries @($requestAuditAfterRetry)
  Assert-CollectionContains `
    -Collection $requestActionsAfterRetry `
    -ExpectedValue 'TIME_OFF_REQUEST_SYNC_RETRY_SUCCEEDED' `
    -Message 'Request audit trail did not record the successful retry'

  $balanceAfterRetry = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balances/${EmployeeId}?locationId=${LocationId}"
  Assert-Equal -Actual $balanceAfterRetry.availableUnits -Expected 7920 -Message 'HCM balance after outbox retry did not match the expected amount'
  Write-Pass "Outbox retry flow completed and was visible through the audit trail."

  Write-Step "Create a new request and force reconciliation drift"
  $driftCreateRequest = Invoke-GraphqlRequest `
    -Query $createMutation `
    -Variables @{
      input = @{
        locationId = $LocationId
        startDate = '2026-06-25T00:00:00.000Z'
        endDate = '2026-06-26T00:00:00.000Z'
        requestedUnits = 60
        reason = 'PowerShell smoke drift flow'
      }
    } `
    -Headers (New-EmployeeHeaders -IdempotencyKey "powershell-create-drift-$runToken")
  $summary.driftRequestId = $driftCreateRequest.createTimeOffRequest.id
  Assert-Equal -Actual $driftCreateRequest.createTimeOffRequest.status -Expected 'PENDING' -Message 'Drift test request was not created as PENDING'

  $null = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedHcmBaseUrl/scenarios/drift" `
    -Body @{
      employeeId = $EmployeeId
      locationId = $LocationId
      availableUnits = 10
      sourceUpdatedAt = '2026-04-10T09:00:00.000Z'
    }

  $driftedBatchSnapshot = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balance-snapshots"

  $driftSyncResponse = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/hcm-sync/balance-snapshots" `
    -Headers $internalHeaders `
    -Body @{
      runId = "powershell-drift-sync-$runToken"
      sentAt = (Get-Date).ToUniversalTime().ToString('o')
      records = @($driftedBatchSnapshot.records)
    }
  $summary.driftSyncRunId = $driftSyncResponse.syncRunId
  Assert-Equal -Actual $driftSyncResponse.status -Expected 'COMPLETED' -Message 'Drift reconciliation sync did not complete'
  Assert-Condition -Condition ($driftSyncResponse.requestsFlagged -ge 1) -Message 'Drift reconciliation did not flag any requests'

  $driftRequestAudit = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/audit/requests/$($summary.driftRequestId)" `
    -Headers $internalHeaders
  $driftRequestActions = Get-AuditActions -AuditEntries @($driftRequestAudit)
  Assert-CollectionContains `
    -Collection $driftRequestActions `
    -ExpectedValue 'BALANCE_RECONCILIATION_FLAGGED' `
    -Message 'Drifted request audit trail did not contain the reconciliation flag action'

  $driftSyncAudit = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/audit/sync-runs/$($summary.driftSyncRunId)" `
    -Headers $internalHeaders
  $driftSyncActions = Get-AuditActions -AuditEntries @($driftSyncAudit)
  Assert-CollectionContains `
    -Collection $driftSyncActions `
    -ExpectedValue 'HCM_BALANCE_BATCH_SYNC_COMPLETED' `
    -Message 'Drift sync audit trail did not contain the batch completion action'
  Write-Pass "Reconciliation drift was detected and audited."

  Write-Step "Recover from drift and approve the request after a balance refresh"
  $null = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedHcmBaseUrl/scenarios/drift" `
    -Body @{
      employeeId = $EmployeeId
      locationId = $LocationId
      availableUnits = 5000
      sourceUpdatedAt = '2026-04-10T10:00:00.000Z'
    }

  $recoveryBatchSnapshot = Invoke-JsonRequest `
    -Method 'GET' `
    -Uri "$script:ResolvedHcmBaseUrl/hcm/balance-snapshots"

  $recoverySyncResponse = Invoke-JsonRequest `
    -Method 'POST' `
    -Uri "$script:ResolvedTimeoffBaseUrl/internal/hcm-sync/balance-snapshots" `
    -Headers $internalHeaders `
    -Body @{
      runId = "powershell-recovery-sync-$runToken"
      sentAt = (Get-Date).ToUniversalTime().ToString('o')
      records = @($recoveryBatchSnapshot.records)
    }
  $summary.recoverySyncRunId = $recoverySyncResponse.syncRunId
  Assert-Equal -Actual $recoverySyncResponse.status -Expected 'COMPLETED' -Message 'Recovery batch sync did not complete'

  $recoveredApproval = Invoke-GraphqlRequest `
    -Query $approveMutation `
    -Variables @{
      input = @{
        requestId = $summary.driftRequestId
        reason = 'Approved after HCM refresh'
      }
    } `
    -Headers (New-ManagerHeaders -IdempotencyKey "powershell-approve-recovery-$runToken")
  Assert-Equal -Actual $recoveredApproval.approveTimeOffRequest.status -Expected 'APPROVED' -Message 'Recovered request did not transition to APPROVED'
  Assert-Equal -Actual $recoveredApproval.approveTimeOffRequest.approvedBy -Expected $ManagerId -Message 'Recovered approval did not record the manager id'
  Write-Pass "Recovered request was approved after the refreshed HCM balance import."

  Write-Step "Clear any leftover forced adjustment error"
  $null = Invoke-JsonRequest `
    -Method 'DELETE' `
    -Uri "$script:ResolvedHcmBaseUrl/scenarios/force-next-adjustment-error"
  Write-Pass "Mock HCM forced error state cleared."

  Write-Step "Completed"
  $summaryJson = $summary | ConvertTo-Json -Depth 5
  Write-Host $summaryJson -ForegroundColor Yellow
}
catch {
  Write-Host ""
  Write-Host "Endpoint smoke test failed." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
