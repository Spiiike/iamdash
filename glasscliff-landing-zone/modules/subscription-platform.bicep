// Subscription-level platform pieces: central logging, activity log export
// and a budget. In a multi-subscription landing zone the workspace would live
// in a dedicated management subscription under Platform; this lab has one
// subscription, so it lives in its own resource group here instead.
targetScope = 'subscription'

param location string
param alertEmail string
param monthlyBudget int
param budgetStartDate string

var tags = { owner: 'antalon', environment: 'platform', workload: 'glasscliff-landing-zone' }

resource platformRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-glasscliff-platform'
  location: location
  tags: tags
}

module workspace 'log-analytics.bicep' = {
  name: 'glasscliff-log-analytics'
  scope: platformRg
  params: { location: location, tags: tags }
}

// Every control-plane action in the subscription (who created, changed or
// deleted what, and every policy decision) goes to the central workspace.
resource activityLog 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'glasscliff-activity-to-log-analytics'
  properties: {
    workspaceId: workspace.outputs.id
    logs: [for category in ['Administrative', 'Security', 'ServiceHealth', 'Alert', 'Recommendation', 'Policy', 'Autoscale', 'ResourceHealth']: {
      category: category
      enabled: true
    }]
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'glasscliff-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThan', threshold: 50, thresholdType: 'Actual', contactEmails: [alertEmail] }
      actual80: { enabled: true, operator: 'GreaterThan', threshold: 80, thresholdType: 'Actual', contactEmails: [alertEmail] }
      forecast100: { enabled: true, operator: 'GreaterThan', threshold: 100, thresholdType: 'Forecasted', contactEmails: [alertEmail] }
    }
  }
}

output workspaceId string = workspace.outputs.id
