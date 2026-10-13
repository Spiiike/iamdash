// Deployment 2 of 2: guardrails, logging, budget and access.
//
// Runs at the Glasscliff management group:
//   az deployment mg create --management-group-id glasscliff -l eastus2 -f 2-platform.bicep -p @platform.parameters.json
//
// Every guardrail starts in Audit. Audit reports what would be blocked without
// blocking anything, so the identity lab keeps running while you read the
// findings. Flip policyEffect to Deny only once the findings are fixed or
// deliberately accepted.
targetScope = 'managementGroup'

@description('Audit reports; Deny blocks. Start with Audit.')
@allowed(['Audit', 'Deny', 'Disabled'])
param policyEffect string = 'Audit'

@description('Resource groups the guardrails apply to. Empty (the default) assigns them at the management group, so every subscription beneath it is covered. List one or more names to assign them to just those resource groups in workloadSubscriptionId instead; they must already exist.')
param assignmentResourceGroups array = []

@description('Regions workloads may use.')
param allowedLocations array = ['eastus2']

@description('Subscription that holds the identity lab (and, in this single-subscription lab, the platform logging too).')
param workloadSubscriptionId string

@description('Region for platform resources.')
param location string = 'eastus2'

@description('Where budget alerts go.')
param alertEmail string

@description('Monthly budget for the subscription, in its billing currency.')
param monthlyBudget int = 30

@description('First day of the month the budget starts. Leave the default.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Object id of wetcliff\'s system-assigned identity. It gets Reader here so the site can show the platform live.')
param webAppPrincipalId string = ''

// --------------------------------------------------------------- policies --
// Policy rules contain expressions such as [parameters('effect')] that must
// reach Azure as literal text for the policy engine. They are written
// directly into each resource, never stored in variables: ARM re-evaluates
// nested variables, which strips the escaping and makes the deployment try to
// resolve the policy's own parameters as template parameters.

var effectParam = {
  type: 'String'
  allowedValues: ['Audit', 'Deny', 'Disabled']
  defaultValue: 'Audit'
  metadata: { displayName: 'Effect' }
}
var category = { category: 'Glasscliff guardrails', version: '1.0.0' }

resource allowedLocationsDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: 'glasscliff-allowedlocations'
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'Glasscliff: resources must be in an allowed region'
    description: 'Keeps workloads in the regions this platform supports. Global resources are exempt.'
    metadata: category
    parameters: {
      allowedLocations: { type: 'Array', metadata: { displayName: 'Allowed regions', strongType: 'location' } }
      effect: effectParam
    }
    policyRule: {
      if: {
        allOf: [
          { field: 'location', notIn: '[parameters(\'allowedLocations\')]' }
          { field: 'location', notEquals: 'global' }
        ]
      }
      then: { effect: '[parameters(\'effect\')]' }
    }
  }
}

resource requireTagDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: 'glasscliff-requiretag'
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'Glasscliff: resources must carry a required tag'
    description: 'Every resource says who owns it and which environment it belongs to, so cost and incidents have somewhere to go.'
    metadata: category
    parameters: {
      tagName: { type: 'String', metadata: { displayName: 'Tag name' } }
      effect: effectParam
    }
    policyRule: {
      if: { field: '[concat(\'tags[\', parameters(\'tagName\'), \']\')]', exists: 'false' }
      then: { effect: '[parameters(\'effect\')]' }
    }
  }
}

resource noPublicIpDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: 'glasscliff-nopublicip'
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'Glasscliff: no standalone public IP addresses'
    description: 'Public IPs are the most common way a VM ends up on the internet by accident. Internet-facing services go through a managed front door instead.'
    metadata: category
    parameters: { effect: effectParam }
    policyRule: {
      if: { field: 'type', equals: 'Microsoft.Network/publicIPAddresses' }
      then: { effect: '[parameters(\'effect\')]' }
    }
  }
}

resource storageSecureTransportDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: 'glasscliff-storagesecuretransport'
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: 'Glasscliff: storage accounts must use HTTPS and TLS 1.2'
    description: 'No plain-HTTP access to storage, and no TLS versions older than 1.2.'
    metadata: category
    parameters: { effect: effectParam }
    policyRule: {
      if: {
        allOf: [
          { field: 'type', equals: 'Microsoft.Storage/storageAccounts' }
          {
            anyOf: [
              { field: 'Microsoft.Storage/storageAccounts/supportsHttpsTrafficOnly', notEquals: true }
              { field: 'Microsoft.Storage/storageAccounts/minimumTlsVersion', notEquals: 'TLS1_2' }
            ]
          }
        ]
      }
      then: { effect: '[parameters(\'effect\')]' }
    }
  }
}

// The initiative's rule list is written out in full on purpose. Built with a
// loop, ARM re-evaluates the loop's output and executes the policy engine's
// own [parameters('effect')] as if it were a template parameter. Five static
// entries avoid that entirely. Adding a required tag means adding an entry.
resource baseline 'Microsoft.Authorization/policySetDefinitions@2023-04-01' = {
  name: 'glasscliff-baseline'
  properties: {
    policyType: 'Custom'
    displayName: 'Glasscliff baseline guardrails'
    description: 'The rules every Glasscliff workload lands under: allowed regions, required tags, no stray public IPs, secure storage transport.'
    metadata: category
    parameters: {
      effect: { type: 'String', allowedValues: ['Audit', 'Deny', 'Disabled'], defaultValue: 'Audit' }
      allowedLocations: { type: 'Array' }
    }
    policyDefinitions: [
      {
        policyDefinitionReferenceId: 'allowed-locations'
        policyDefinitionId: allowedLocationsDef.id
        parameters: {
          effect: { value: '[parameters(\'effect\')]' }
          allowedLocations: { value: '[parameters(\'allowedLocations\')]' }
        }
      }
      {
        policyDefinitionReferenceId: 'no-public-ip'
        policyDefinitionId: noPublicIpDef.id
        parameters: {
          effect: { value: '[parameters(\'effect\')]' }
        }
      }
      {
        policyDefinitionReferenceId: 'storage-secure-transport'
        policyDefinitionId: storageSecureTransportDef.id
        parameters: {
          effect: { value: '[parameters(\'effect\')]' }
        }
      }
      {
        policyDefinitionReferenceId: 'require-tag-owner'
        policyDefinitionId: requireTagDef.id
        parameters: {
          effect: { value: '[parameters(\'effect\')]' }
          tagName: { value: 'owner' }
        }
      }
      {
        policyDefinitionReferenceId: 'require-tag-environment'
        policyDefinitionId: requireTagDef.id
        parameters: {
          effect: { value: '[parameters(\'effect\')]' }
          tagName: { value: 'environment' }
        }
      }
    ]
  }
}

// Management group scope (default): every subscription beneath it inherits the rules.
resource baselineAssignment 'Microsoft.Authorization/policyAssignments@2024-04-01' = if (empty(assignmentResourceGroups)) {
  name: 'glasscliff-baseline'
  properties: {
    displayName: 'Glasscliff baseline guardrails'
    description: 'Assigned at the Glasscliff management group, so every subscription beneath it inherits these rules.'
    policyDefinitionId: baseline.id
    enforcementMode: 'Default'
    parameters: {
      effect: { value: policyEffect }
      allowedLocations: { value: allowedLocations }
    }
  }
}

// Resource group scope: the same initiative, assigned only where you say.
// Use this when a management-group assignment would get in the way of other work.
module rgAssignments 'modules/baseline-assignment.bicep' = [for rg in assignmentResourceGroups: {
  name: 'glasscliff-baseline-${rg}'
  scope: resourceGroup(workloadSubscriptionId, rg)
  params: {
    initiativeId: baseline.id
    policyEffect: policyEffect
    allowedLocations: allowedLocations
  }
}]

// ------------------------------------------------------------------ access --
var readerRole = 'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader (verify: az role definition list --name Reader --query [].name -o tsv)

resource siteReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppPrincipalId)) {
  name: guid(managementGroup().id, webAppPrincipalId, readerRole)
  properties: {
    principalId: webAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: tenantResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    description: 'wetcliff reads the platform (hierarchy, compliance, spend) to show it on glasscliff.online.'
  }
}

// ----------------------------------------------------- logging and budget --
module subscriptionPlatform 'modules/subscription-platform.bicep' = {
  name: 'glasscliff-subscription-platform'
  scope: subscription(workloadSubscriptionId)
  params: {
    location: location
    alertEmail: alertEmail
    monthlyBudget: monthlyBudget
    budgetStartDate: budgetStartDate
  }
}

output policyAssignmentScope string = empty(assignmentResourceGroups) ? 'managementGroup' : 'resourceGroup'
output managementGroupAssignmentId string = empty(assignmentResourceGroups) ? baselineAssignment.id : ''
output resourceGroupAssignmentIds array = [for (rg, i) in assignmentResourceGroups: rgAssignments[i].outputs.assignmentId]
output effect string = policyEffect
output logAnalyticsWorkspaceId string = subscriptionPlatform.outputs.workspaceId
