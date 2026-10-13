// Deployment 1 of 2: the management group hierarchy.
//
// Runs at tenant scope, which needs temporarily elevated access (see README).
// Remove the elevation as soon as this finishes: deployment 2 runs at the
// Glasscliff management group, where the creator already holds Owner.
//
//   Tenant root
//   └── Glasscliff                      policies and logging are assigned here
//       ├── Platform                    shared services (logging lives here in a
//       │                               multi-subscription design)
//       ├── Landing Zones
//       │   └── Online                  internet-facing workloads: the identity lab
//       ├── Sandbox                     experiments, looser rules
//       └── Decommissioned              subscriptions on their way out
targetScope = 'tenant'

@description('The subscription that holds the identity lab. It is placed under Landing Zones / Online.')
param workloadSubscriptionId string

@description('Prefix for management group ids. Ids are permanent, so choose once.')
param prefix string = 'glasscliff'

var rootId = tenantResourceId('Microsoft.Management/managementGroups', tenant().tenantId)

resource top 'Microsoft.Management/managementGroups@2023-04-01' = {
  name: prefix
  properties: {
    displayName: 'Glasscliff'
    details: { parent: { id: rootId } }
  }
}

resource platform 'Microsoft.Management/managementGroups@2023-04-01' = {
  name: '${prefix}-platform'
  properties: {
    displayName: 'Platform'
    details: { parent: { id: top.id } }
  }
}

resource landingZones 'Microsoft.Management/managementGroups@2023-04-01' = {
  name: '${prefix}-landingzones'
  properties: {
    displayName: 'Landing Zones'
    details: { parent: { id: top.id } }
  }
}

resource online 'Microsoft.Management/managementGroups@2023-04-01' = {
  name: '${prefix}-online'
  properties: {
    displayName: 'Online'
    details: { parent: { id: landingZones.id } }
  }
}

resource sandbox 'Microsoft.Management/managementGroups@2023-04-01' = {
  name: '${prefix}-sandbox'
  properties: {
    displayName: 'Sandbox'
    details: { parent: { id: top.id } }
  }
}

resource decommissioned 'Microsoft.Management/managementGroups@2023-04-01' = {
  name: '${prefix}-decommissioned'
  properties: {
    displayName: 'Decommissioned'
    details: { parent: { id: top.id } }
  }
}

// Moving the subscription is what makes the Glasscliff policies apply to it.
resource placement 'Microsoft.Management/managementGroups/subscriptions@2023-04-01' = {
  parent: online
  name: workloadSubscriptionId
}

output topManagementGroupId string = top.name
output workloadManagementGroupId string = online.name
