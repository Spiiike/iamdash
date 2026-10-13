// The baseline initiative, assigned to one resource group.
//
// Deployed by 2-platform.bicep when assignmentResourceGroups is not empty. The
// initiative itself stays at the Glasscliff management group; only the
// assignment moves down, so the rules apply to this resource group and nothing
// else in the subscription.
targetScope = 'resourceGroup'

param initiativeId string
param policyEffect string
param allowedLocations array

resource assignment 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: 'glasscliff-baseline'
  properties: {
    displayName: 'Glasscliff baseline guardrails'
    description: 'Assigned to this resource group only, so the rest of the subscription is unaffected.'
    policyDefinitionId: initiativeId
    enforcementMode: 'Default'
    parameters: {
      effect: { value: policyEffect }
      allowedLocations: { value: allowedLocations }
    }
  }
}

output assignmentId string = assignment.id
