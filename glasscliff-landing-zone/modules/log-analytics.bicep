// Central Log Analytics workspace. The daily cap bounds cost: at lab volume
// activity logs are a tiny fraction of it, but a noisy misconfiguration can
// never run up a bill.
param location string
param tags object

@description('Hard ceiling on ingestion per day, in GB.')
param dailyCapGb int = 1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-glasscliff-platform'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: dailyCapGb }
  }
}

output id string = workspace.id
