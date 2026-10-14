/*
================================================================================
 Glasscliff Identity Lifecycle Lab — Azure infrastructure (Bicep)
================================================================================
 Scope: resourceGroup
 Deploy:
   az group create -n rg-glasscliff-lab -l eastus
   az deployment group create -g rg-glasscliff-lab \
     -f main.bicep -p main.parameters.json

 REDEPLOYING AN EXISTING LAB — read this first
   Every Key Vault secret is written on every deployment. A secret parameter
   left empty becomes a SET-ME- placeholder, and an empty scimBearerToken or
   operatorApiKey is regenerated from newGuid(). Redeploying with the blank
   values in main.parameters.example.json breaks Okta's SCIM connection, the
   Expenses sign-in and the operator key. Either pass the real values for
   every secret parameter, or change app settings directly with
   `az webapp config appsettings set` and leave this template alone.

 What this template DOES build
   • Azure Functions (Linux Consumption Y1, or Elastic Premium EP1) hosting BOTH:
       - Lifecycle API   /api/lifecycle/{hire|transfer|terminate|status}   (operator API key)
       - SCIM 2.0 endpoint /api/scim/v2/{Users,Groups}                    (bearer token)
       - OIDC callback/session helpers for "Glasscliff Expenses"
   • Storage Account + Table Storage (Accounts, Applications, Operations,
     OperationSteps, Evidence, Sessions, Idempotency) + blob containers for
     sanitized SCIM transcripts and synthetic scenario playback payloads
   • Key Vault (RBAC model) holding Okta API token, Okta client secret,
     OIDC client secret, SCIM bearer token, operator API key
   • A user-assigned managed identity for the Function App. Its Key Vault and
     storage roles are granted BEFORE the Function App is created, so the
     @Microsoft.KeyVault(...) app setting references resolve on first start.
   • Log Analytics + Application Insights
   • App settings MERGED into your EXISTING App Service (site is not recreated),
     via a module so it works even when that site lives in another RG.

 What this template CANNOT build
   • The Okta test tenant. Okta Workforce Identity Cloud is not an Azure
     resource type; the org is created out-of-band (developer.okta.com signup,
     or the Okta Org Signup API from your GitHub Actions workflow). This
     template consumes the org URL, API token, client id/secret and the
     Expenses app id as parameters and lands them in Key Vault.
   • The Okta app integration for Expenses OIDC login — created in the Okta
     admin UI (Applications → Create App Integration → OIDC), because the IdP
     for the demo is Okta itself.

 FIRST MILESTONE PATH (validate Okta -> SCIM before building the dashboard)
   1. Deploy this file.
   2. Read the SCIM token from Key Vault (see outputs.secretRetrievalCommands).
      Secrets are deliberately NOT returned as deployment outputs.
   3. Okta admin → Applications → Create App Integration → "SCIM connector".
      Base URL = https://<functionAppHostName>/api/scim/v2
      API token = value of the 'scim-bearer-token' Key Vault secret
   4. Test Connector Configuration (expect HTTP 200 on /ServiceProviderConfig).
   5. Provisioning → Create Users / Update Attributes / Deactivate Users = ON.
   6. Assignments → assign your one test employee.
   7. Check outputs.tableNames -> Accounts + OperationSteps rows and the
      'evidence' blob container for the sanitized request/response pair.

 REDEPLOY WARNING
   If scimBearerToken / operatorApiKey are left empty, a NEW random value is
   generated on EVERY deployment and written to Key Vault, which breaks the
   Okta SCIM connector. After the first deployment, pass the existing values
   explicitly (see outputs.secretRetrievalCommands).
================================================================================
*/

targetScope = 'resourceGroup'

// ---------------------------------------------------------------- naming ----
@description('Base name used to construct every resource name.')
@minLength(3)
@maxLength(12)
param projectName string = 'glasscliff'

// NOTE: this parameter shadows the built-in environment() function, so the
// function is always called as az.environment() in this file.
@description('Lab slot. Keeps names short and deterministic.')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for everything in this template.')
param location string = resourceGroup().location

// --------------------------------------------------- existing App Service ----
@description('Name of the EXISTING App Service that serves /labs/identity. It is left in place; only app settings are merged.')
param webAppName string

@description('Resource group of the existing App Service (may differ from this deployment RG).')
param webAppResourceGroupName string = resourceGroup().name

@description('Principal ID of the existing App Service system-assigned identity. Leave empty to skip its Key Vault grant. Get it with: az webapp identity show -n <webAppName> -g <webAppResourceGroupName> --query principalId -o tsv')
param webAppManagedIdentityPrincipalId string = ''

@description('Custom domain the site is served on, e.g. projects.glasscliff.online. Expenses sign-in redirects, the lab URL and CORS use it. Leave empty to use the App Service default hostname (*.azurewebsites.net). The same callback URL must be a sign-in redirect URI on the Okta Expenses OIDC app.')
param publicHostName string = ''

@description('Extra origins allowed to call the Function App from a browser. The App Service default hostname and publicHostName are always included.')
param allowedOrigins array = []

@description('When false, the existing App Service is not touched at all (app settings must be added manually).')
param updateExistingWebAppSettings bool = true

// --------------------------------------------------------- Function App ------
// FC1 (Flex Consumption) was removed: it needs a different site shape
// (functionAppConfig, deployment storage, no linuxFxVersion / content share).
@description('Y1 = Linux Consumption (cheapest, use this), EP1 = Elastic Premium.')
@allowed(['Y1', 'EP1'])
param functionPlanSku string = 'Y1'

@description('Functions runtime. SCIM + lifecycle handlers are written for Node 20 in this lab.')
@allowed(['node|20', 'python|3.11', 'dotnet-isolated|8.0'])
param functionRuntime string = 'node|20'

// ----------------------------------------------------------------- Okta ------
@description('Okta tenant base URL, e.g. https://glasscliff-1234.oktapreview.com (no trailing slash).')
param oktaOrgUrl string = ''

@description('Okta OIDC/OAuth client id used by the lifecycle API for server-to-server calls.')
param oktaClientId string = ''

@secure()
@description('Okta OIDC/OAuth client secret. Stored in Key Vault. Leave empty to deploy with a placeholder and rotate later.')
param oktaClientSecret string = ''

@secure()
@description('Okta API token (SSWS) for the lab service account. Used by the Hire/Transfer/Terminate handlers.')
param oktaApiToken string = ''

@description('How the lifecycle handlers authenticate to the Okta management API. Explicit so it does not silently flip when the token is rotated in Key Vault instead of via redeploy.')
@allowed(['SSWS', 'OAuth'])
param oktaAuthMode string = 'SSWS'

@description('Public demo: visitors can run a throwaway hire, role change and offboarding.')
param demoEnabled bool = true

@description('Domain used for invented demo logins. Use one you control that has no mailbox.')
param demoEmailDomain string = 'demo.glasscliff.online'

@description('Minutes before a demo user is offboarded and deleted.')
param demoTtlMinutes int = 8

@description('How many demo users may exist at once.')
param demoMaxLive int = 3

@description('How many demo runs may start in one day.')
param demoDailyMax int = 30

@description('Okta group (00g...) demo people are created in. Assign Expenses to it and give it a password-only sign-on rule; see docs/visitor-sign-in.md.')
param demoOktaGroupId string = ''

@description('Okta application instance id for the fictional "Glasscliff Expenses" app (0oa...).')
param oktaExpensesAppId string = ''

@description('Okta authorization server id.')
param oktaAuthorizationServerId string = 'default'

// ------------------------------- Entra ID + Google: verification and recon ---
@description('Okta app instance id (0oa...) of the Office 365 app that provisions Entra ID. Assignment to it is what makes an Entra account expected.')
param oktaEntraAppId string = ''

@description('Okta app instance id (0oa...) of the Google Workspace app that provisions Cloud Identity.')
param oktaGoogleAppId string = ''

@description('Optional: Okta group assigned to both downstream apps. When set, an operator hire with downstream=true adds the person to it instead of assigning each app.')
param oktaDownstreamGroupId string = ''

@description('Directories the lifecycle API verifies after Okta changes someone: "", "entra", "google" or "entra,google". Empty keeps the Expenses-only behaviour.')
param downstreamVerify string = ''

@description('Google service account the reconciler and the verify.google steps read with (recon@<project>.iam.gserviceaccount.com).')
param googleSaClientEmail string = ''

@secure()
@description('That service account\'s private key (PEM). Stored in Key Vault. Leave EMPTY on later deploys: unlike the other secrets, an empty value leaves the stored key alone instead of overwriting it with a placeholder.')
param googleSaPrivateKey string = ''

@description('Only for the domain-wide-delegation route: the admin the service account impersonates. Leave empty when the service account holds a read-only admin role itself (preferred).')
param googleAdminSubject string = ''

@description('Accounts that are meant to exist downstream with no Okta identity (break-glass, connector service accounts), as a JSON array. See src/lib/recon in the Functions app.')
param reconExceptions string = '[]'

@description('The Google OU the SSO profile is assigned to; Okta-managed accounts outside it are flagged.')
param reconManagedOu string = '/Okta Users'

@description('Only when the federated Entra tenant is NOT the tenant that holds this subscription: that tenant\'s id. A managed identity cannot be granted Graph permissions in another tenant, so an app registration there is used instead.')
param entraTenantId string = ''

@description('Client id of that app registration (application permission: Microsoft Graph User.Read.All, admin-consented).')
param entraClientId string = ''

@secure()
@description('Its client secret. Stored in Key Vault. Empty on later deploys leaves the stored value alone.')
param entraClientSecret string = ''

@secure()
@description('Optional read-only Okta API token for the reconciler (created by a Read-Only Admin). Without it the reconciler reads with the lifecycle token, which can also write. Empty on later deploys leaves the stored value alone.')
param reconOktaApiToken string = ''

@description('Turns on the public reconciliation page on the site. Set true only after the first reconciliation has completed (POST /api/recon/run).')
param reconEnabled bool = false

// ------------------------------------------ Glasscliff Expenses OIDC login ---
@description('OIDC client id the Expenses login flow uses against the Okta tenant.')
param expensesOidcClientId string = ''

@secure()
@description('OIDC client secret for Expenses. Stored in Key Vault, referenced by both the site and the Function App.')
param expensesOidcClientSecret string = ''

// --------------------------------------------------------------- secrets -----
@secure()
@description('Bearer token Okta presents to /api/scim/v2. Generated when empty — see REDEPLOY WARNING in the header.')
param scimBearerToken string = ''

@secure()
@description('Header value the authenticated operator interface presents to /api/lifecycle. Generated when empty.')
param operatorApiKey string = ''

// newGuid() is only allowed as a parameter default, so the generator seeds live here.
@secure()
@description('Internal: random seed used only when scimBearerToken is empty. Do not set.')
param generatedScimBearerTokenSeed string = newGuid()

@secure()
@description('Internal: random seed used only when operatorApiKey is empty. Do not set.')
param generatedOperatorApiKeySeed string = newGuid()

@description('Internal: base time for Key Vault secret expiry. Do not set.')
param deploymentTimestamp string = utcNow()

@description('Object ID of a user/group/service principal that should be able to read and rotate lab secrets (Key Vault Secrets Officer). Empty = no grant.')
param keyVaultAdministratorObjectId string = ''

@description('Principal type of keyVaultAdministratorObjectId.')
@allowed(['User', 'Group', 'ServicePrincipal'])
param keyVaultAdministratorPrincipalType string = 'User'

@description('Number of attempts for a failed lifecycle step before the operation is marked terminal.')
@minValue(1)
@maxValue(10)
param maxStepRetries int = 3

// ------------------------------------------------------------- variables -----
var safeName = toLower(replace(replace(projectName, '-', ''), '_', ''))
var proj = take(safeName, 8)
var suffix = take(uniqueString(resourceGroup().id, environment), 6)

@description('Landing zone: attributed to every resource this template creates, and required by the glasscliff-baseline policy at the management group.')
param owner string = 'antalon'

var tags = {
  owner: owner
  project: 'glasscliff-identity-lifecycle-lab'
  environment: environment
  interface: '/labs/identity'
  managedBy: 'bicep'
}

// Max lengths: storage 24 (lowercase alnum), Key Vault 24, others well within limits.
var storageAccountName = 'st${proj}${environment}${suffix}'
var keyVaultName = 'kv-${proj}-${environment}-${suffix}'
var logAnalyticsName = 'log-${proj}-${environment}-${suffix}'
var appInsightsName = 'appi-${proj}-${environment}-${suffix}'
var appServicePlanName = 'asp-${proj}-${environment}-${suffix}'
var functionAppName = 'func-${proj}-${environment}-${suffix}'
var functionIdentityName = 'id-func-${proj}-${environment}-${suffix}'

var tableNames = [
  'Accounts'       // per-application account state for each identity
  'Applications'   // catalog of downstream apps (Glasscliff Expenses, ...)
  'Operations'     // hire / transfer / terminate requests
  'OperationSteps' // okta -> scim -> verify
  'Evidence'       // before/after snapshots + sanitized SCIM transcripts
  'Sessions'       // application sessions, used by the offboarding check
  'Idempotency'    // webhook + retry de-duplication
  'DemoUsers'      // public demo: throwaway identities and their expiry
]

var containerNames = [
  'evidence'          // sanitized SCIM requests/responses, JSON + HAR artifacts
  'scenarios'         // synthetic playback payloads for public visitors
  'recon'             // reconciliation results: latest.json + history/ (unmasked, private)
  'function-releases' // deployment packages
]

// Generated secrets (only when the caller did not supply one)
var scimBearerTokenValue = empty(scimBearerToken) ? 'scim-${replace(generatedScimBearerTokenSeed, '-', '')}' : scimBearerToken
var operatorApiKeyValue = empty(operatorApiKey) ? 'opk-${replace(generatedOperatorApiKeySeed, '-', '')}' : operatorApiKey
var placeholderPrefix = 'SET-ME-'
var secretExpiryEpoch = dateTimeToEpoch(dateTimeAdd(deploymentTimestamp, 'P1Y'))

var storageSuffix = az.environment().suffixes.storage
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${storageSuffix}'
var kvUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/'

var workerRuntime = startsWith(functionRuntime, 'node') ? 'node' : (startsWith(functionRuntime, 'python') ? 'python' : 'dotnet-isolated')

var oktaAuthority = empty(oktaOrgUrl) ? '' : '${oktaOrgUrl}/oauth2/${oktaAuthorizationServerId}'

// Predictable host name, used where the Function App must refer to itself.
var functionAppPredictedHostName = '${functionAppName}.azurewebsites.net'

// Built-in Azure role definitions
var roleKeyVaultSecretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var roleKeyVaultSecretsOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var roleStorageBlobDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var roleStorageTableDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var roleStorageTableDataReader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '76199698-9eea-4c19-bc75-cec21354c6b6')
var roleStorageBlobDataReader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var roleStorageQueueDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var roleMonitoringMetricsPublisher = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')

var planSku = functionPlanSku == 'EP1'
  ? {
      name: 'EP1'
      tier: 'ElasticPremium'
    }
  : {
      name: 'Y1'
      tier: 'Dynamic'
    }

// ------------------------------------------------------- existing web app ----
resource existingWebApp 'Microsoft.Web/sites@2023-12-01' existing = {
  scope: resourceGroup(webAppResourceGroupName)
  name: webAppName
}

var webAppHostName = existingWebApp.properties.defaultHostName
// The host people actually visit. Expenses' OIDC redirect and the canonical-host
// redirect in server.js both follow this, so it must be the custom domain once
// one is bound, or visitors get bounced to *.azurewebsites.net.
var webAppPublicHostName = empty(publicHostName) ? webAppHostName : publicHostName
var webAppUrl = 'https://${webAppPublicHostName}/labs/identity'
var corsOrigins = union(
  [
    'https://${webAppHostName}'
    'https://${webAppPublicHostName}'
  ],
  allowedOrigins
)

// ------------------------------------------------------------ observability --
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      searchVersion: 1
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    workspaceCapping: {
      dailyQuotaGb: -1
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    Flow_Type: 'Bluefield'
    Request_Source: 'rest'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    DisableIpMasking: false
  }
}

// ------------------------------------------------------------------ storage --
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    // Shared key stays on because the Linux Consumption host needs a
    // connection string for AzureWebJobsStorage + the content file share.
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource storageTables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = [
  for tableName in tableNames: {
    parent: tableService
    name: tableName
  }
]

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = [
  for containerName in containerNames: {
    parent: blobService
    name: containerName
    properties: {
      publicAccess: 'None'
    }
  }
]

// --------------------------------------------------------------- key vault ---
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // Purge protection deliberately OFF so the lab can be torn down and redeployed.
    // A soft-deleted vault with the same name still blocks redeploy for 7 days
    // unless purged: az keyvault purge -n <keyVaultName>
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Loop array must be computable at deployment start, so the storage
// connection string (runtime listKeys) is a separate resource below.
var keyVaultSecrets = [
  {
    name: 'okta-api-token'
    value: empty(oktaApiToken) ? '${placeholderPrefix}okta-api-token' : oktaApiToken
  }
  {
    name: 'okta-client-secret'
    value: empty(oktaClientSecret) ? '${placeholderPrefix}okta-client-secret' : oktaClientSecret
  }
  {
    name: 'expenses-oidc-client-secret'
    value: empty(expensesOidcClientSecret) ? '${placeholderPrefix}expenses-oidc-client-secret' : expensesOidcClientSecret
  }
  {
    name: 'scim-bearer-token'
    value: scimBearerTokenValue
  }
  {
    name: 'operator-api-key'
    value: operatorApiKeyValue
  }
]

resource kvSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for secret in keyVaultSecrets: {
    parent: keyVault
    name: secret.name
    properties: {
      value: secret.value
      contentType: 'text/plain'
      attributes: {
        enabled: true
        exp: secretExpiryEpoch
      }
    }
  }
]

resource kvStorageConnectionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'storage-connection-string'
  properties: {
    value: storageConnectionString
    contentType: 'text/plain'
    attributes: {
      enabled: true
      exp: secretExpiryEpoch
    }
  }
}

// Written only when a key is supplied, so a redeploy without it keeps the stored
// key. (The secrets above are overwritten with a SET-ME- placeholder when their
// parameter is empty; that is fine for generated values, not for this one.)
resource kvGoogleSaKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(googleSaPrivateKey)) {
  parent: keyVault
  name: 'google-sa-private-key'
  properties: {
    value: googleSaPrivateKey
    contentType: 'application/x-pem-file'
    attributes: {
      enabled: true
      exp: secretExpiryEpoch
    }
  }
}

resource kvEntraClientSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(entraClientSecret)) {
  parent: keyVault
  name: 'entra-recon-client-secret'
  properties: {
    value: entraClientSecret
    contentType: 'text/plain'
    attributes: {
      enabled: true
      exp: secretExpiryEpoch
    }
  }
}

resource kvReconOktaToken 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(reconOktaApiToken)) {
  parent: keyVault
  name: 'recon-okta-api-token'
  properties: {
    value: reconOktaApiToken
    contentType: 'text/plain'
    attributes: {
      enabled: true
      exp: secretExpiryEpoch
    }
  }
}

// ------------------------------------------- Function App identity + RBAC ---
// User-assigned so its roles exist BEFORE the Function App starts; with a
// system-assigned identity the Key Vault references fail on first boot.
resource functionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: functionIdentityName
  location: location
  tags: tags
}

resource functionKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, functionIdentity.id, 'secretsUser')
  properties: {
    principalId: functionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleKeyVaultSecretsUser
  }
}

resource functionStorageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, functionIdentity.id, 'blobDataContributor')
  properties: {
    principalId: functionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleStorageBlobDataContributor
  }
}

resource functionStorageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, functionIdentity.id, 'tableDataContributor')
  properties: {
    principalId: functionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleStorageTableDataContributor
  }
}

resource functionStorageQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, functionIdentity.id, 'queueDataContributor')
  properties: {
    principalId: functionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleStorageQueueDataContributor
  }
}

resource functionAppInsightsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, functionIdentity.id, 'metricsPublisher')
  properties: {
    principalId: functionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleMonitoringMetricsPublisher
  }
}

// --------------------------------------------------------- function hosting --
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: functionPlanSku == 'EP1' ? 'elastic' : 'linux'
  sku: planSku
  properties: union(
    {
      reserved: true // required for Linux
    },
    functionPlanSku == 'EP1' ? { maximumElasticWorkerCount: 3 } : {}
  )
}

var functionAppSettings = [
  // ---- Functions host ---------------------------------------------------
  {
    name: 'AzureWebJobsStorage'
    value: storageConnectionString
  }
  {
    name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
    value: storageConnectionString
  }
  {
    name: 'WEBSITE_CONTENTSHARE'
    value: toLower(replace(functionAppName, '-', ''))
  }
  {
    name: 'FUNCTIONS_EXTENSION_VERSION'
    value: '~4'
  }
  {
    name: 'FUNCTIONS_WORKER_RUNTIME'
    value: workerRuntime
  }
  // WEBSITE_RUN_FROM_PACKAGE is intentionally NOT set: on Linux Consumption
  // the value '1' is unsupported (it must be a package URL); zip deploy
  // (az functionapp deployment source config-zip) sets it for you.
  {
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'false'
  }
  {
    name: 'ENABLE_ORYX_BUILD'
    value: 'false'
  }
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: appInsights.properties.ConnectionString
  }
  // ---- lab wiring -------------------------------------------------------
  {
    name: 'LAB_PROJECT'
    value: 'glasscliff-identity-lifecycle-lab'
  }
  {
    name: 'LAB_ENVIRONMENT'
    value: environment
  }
  {
    name: 'LAB_PROJECT_INTERFACE_URL'
    value: webAppUrl
  }
  {
    name: 'LAB_MAX_STEP_RETRIES'
    value: string(maxStepRetries)
  }
  {
    name: 'LAB_MODE'
    value: 'hybrid' // synthetic playback for anonymous visitors, live changes for operators
  }
  // ---- persistence ------------------------------------------------------
  {
    name: 'STORAGE_CONNECTION_STRING'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/storage-connection-string)'
  }
  {
    name: 'STORAGE_ACCOUNT_NAME'
    value: storageAccountName
  }
  {
    name: 'STORAGE_TABLE_APPLICATIONS'
    value: 'Applications'
  }
  {
    name: 'STORAGE_TABLE_ACCOUNTS'
    value: 'Accounts'
  }
  {
    name: 'STORAGE_TABLE_OPERATIONS'
    value: 'Operations'
  }
  {
    name: 'STORAGE_TABLE_STEPS'
    value: 'OperationSteps'
  }
  {
    name: 'STORAGE_TABLE_EVIDENCE'
    value: 'Evidence'
  }
  {
    name: 'STORAGE_TABLE_SESSIONS'
    value: 'Sessions'
  }
  {
    name: 'STORAGE_TABLE_IDEMPOTENCY'
    value: 'Idempotency'
  }
  {
    name: 'STORAGE_CONTAINER_EVIDENCE'
    value: 'evidence'
  }
  {
    name: 'STORAGE_CONTAINER_SCENARIOS'
    value: 'scenarios'
  }
  // ---- managed identity (for SDKs using DefaultAzureCredential) ---------
  {
    name: 'AZURE_CLIENT_ID'
    value: functionIdentity.properties.clientId
  }
  // ---- Okta (identity provider) ----------------------------------------
  {
    name: 'OKTA_ORG_URL'
    value: oktaOrgUrl
  }
  {
    name: 'OKTA_AUTHORITY'
    value: oktaAuthority
  }
  {
    name: 'OKTA_CLIENT_ID'
    value: oktaClientId
  }
  {
    name: 'OKTA_CLIENT_SECRET'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/okta-client-secret)'
  }
  {
    name: 'OKTA_API_TOKEN'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/okta-api-token)'
  }
  {
    name: 'OKTA_AUTH_MODE'
    value: oktaAuthMode
  }
  {
    name: 'DEMO_ENABLED'
    value: string(demoEnabled)
  }
  {
    name: 'DEMO_EMAIL_DOMAIN'
    value: demoEmailDomain
  }
  {
    name: 'DEMO_TTL_MINUTES'
    value: string(demoTtlMinutes)
  }
  {
    name: 'DEMO_MAX_LIVE'
    value: string(demoMaxLive)
  }
  {
    name: 'DEMO_DAILY_MAX'
    value: string(demoDailyMax)
  }
  {
    name: 'DEMO_OKTA_GROUP_ID'
    value: demoOktaGroupId
  }
  {
    name: 'OKTA_EXPENSES_APP_ID'
    value: oktaExpensesAppId
  }
  {
    name: 'OKTA_EVENT_WEBHOOK_URL'
    value: 'https://${functionAppPredictedHostName}/api/lifecycle/events/okta'
  }
  // ---- SCIM endpoint (mock Glasscliff Expenses app) ---------------------
  {
    name: 'SCIM_APP_NAME'
    value: 'glasscliff-expenses'
  }
  {
    name: 'SCIM_APP_DISPLAY_NAME'
    value: 'Glasscliff Expenses'
  }
  {
    name: 'SCIM_ROUTE_PREFIX'
    value: 'api/scim/v2'
  }
  {
    name: 'SCIM_BEARER_TOKEN'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/scim-bearer-token)'
  }
  {
    name: 'SCIM_SUPPORTED_SCHEMA'
    value: 'urn:ietf:params:scim:schemas:core:2.0:User'
  }
  {
    name: 'SCIM_SANITIZE_EVIDENCE'
    value: 'true'
  }
  // ---- lifecycle API (operator-only) ------------------------------------
  {
    name: 'API_ROUTE_PREFIX'
    value: 'api/lifecycle'
  }
  {
    name: 'API_OPERATOR_HEADER'
    value: 'x-lab-operator-key'
  }
  {
    name: 'API_OPERATOR_KEY'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/operator-api-key)'
  }
  {
    name: 'API_ALLOWED_ORIGINS'
    value: join(corsOrigins, ',')
  }
  // ---- OIDC login for Expenses ------------------------------------------
  {
    name: 'OIDC_AUTHORITY'
    value: oktaAuthority
  }
  {
    name: 'OIDC_CLIENT_ID'
    value: expensesOidcClientId
  }
  {
    name: 'OIDC_CLIENT_SECRET'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/expenses-oidc-client-secret)'
  }
  {
    name: 'OIDC_REDIRECT_URI'
    value: 'https://${webAppPublicHostName}/labs/identity/expenses/auth/callback'
  }
  {
    name: 'OIDC_POST_LOGOUT_REDIRECT_URI'
    value: 'https://${webAppPublicHostName}/labs/identity/expenses'
  }
  {
    name: 'OIDC_SCOPES'
    value: 'openid profile email groups offline_access'
  }
  // Explicit offboarding check: an identity disabled in Okta must also end
  // every live Expenses session (Sessions table + refresh token revocation).
  {
    name: 'SESSION_INVALIDATION_REQUIRED_ON_TERMINATE'
    value: 'true'
  }
  {
    name: 'SESSION_MAX_AGE_MINUTES'
    value: '30'
  }
  // ---- Key Vault ---------------------------------------------------------
  {
    name: 'KEY_VAULT_URI'
    value: kvUri
  }
  // ---- Entra ID + Google: lifecycle verification and reconciliation -------
  // Entra ID is read with this app's own managed identity (AZURE_CLIENT_ID),
  // which needs Graph User.Read.All: see DEPLOY-RECON.md, step 1. No secret.
  {
    name: 'OKTA_ENTRA_APP_ID'
    value: oktaEntraAppId
  }
  {
    name: 'OKTA_GOOGLE_APP_ID'
    value: oktaGoogleAppId
  }
  {
    name: 'OKTA_DOWNSTREAM_GROUP_ID'
    value: oktaDownstreamGroupId
  }
  {
    name: 'DOWNSTREAM_VERIFY'
    value: downstreamVerify
  }
  {
    name: 'GOOGLE_SA_CLIENT_EMAIL'
    value: googleSaClientEmail
  }
  {
    name: 'GOOGLE_SA_PRIVATE_KEY'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/google-sa-private-key)'
  }
  {
    name: 'GOOGLE_ADMIN_SUBJECT'
    value: googleAdminSubject
  }
  {
    name: 'RECON_EXCEPTIONS'
    value: reconExceptions
  }
  {
    name: 'RECON_MANAGED_OU'
    value: reconManagedOu
  }
  // Unset/unresolved = fall back: Entra via the managed identity, Okta via
  // OKTA_API_TOKEN. A reference to a secret that doesn't exist yet is harmless.
  {
    name: 'ENTRA_TENANT_ID'
    value: entraTenantId
  }
  {
    name: 'ENTRA_CLIENT_ID'
    value: entraClientId
  }
  {
    name: 'ENTRA_CLIENT_SECRET'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/entra-recon-client-secret)'
  }
  {
    name: 'RECON_OKTA_API_TOKEN'
    value: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/recon-okta-api-token)'
  }
]

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: union(tags, {
    role: 'lifecycle-api + scim-endpoint + expenses-oidc'
  })
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${functionIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    reserved: true
    httpsOnly: true
    clientAffinityEnabled: false
    clientCertEnabled: false
    publicNetworkAccess: 'Enabled'
    keyVaultReferenceIdentity: functionIdentity.id
    siteConfig: {
      linuxFxVersion: toUpper(functionRuntime)
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      alwaysOn: false // not supported on Y1; EP1 uses pre-warmed instances instead
      cors: {
        allowedOrigins: corsOrigins
        supportCredentials: false
      }
      appSettings: functionAppSettings
    }
  }
  dependsOn: [
    kvSecrets
    kvStorageConnectionSecret
    storageTables
    blobContainers
    functionKvRole
    functionStorageBlobRole
    functionStorageTableRole
    functionStorageQueueRole
  ]
}

// ------------------------------------------------ existing App Service merge -
var webAppSettingsDelta = {
  LAB_API_BASE_URL: 'https://${functionApp.properties.defaultHostName}'
  LAB_LIFECYCLE_ENDPOINT: 'https://${functionApp.properties.defaultHostName}/api/lifecycle'
  LAB_SCIM_ENDPOINT: 'https://${functionApp.properties.defaultHostName}/api/scim/v2'
  LAB_OPERATOR_HEADER: 'x-lab-operator-key'
  LAB_OPERATOR_KEY: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/operator-api-key)'
  LAB_ROUTE: '/labs/identity'
  LAB_MODE: 'hybrid'
  LAB_SYNTHETIC_SCENARIO_CONTAINER: 'https://${storageAccountName}.blob.${storageSuffix}/scenarios'
  LAB_KEY_VAULT_URI: kvUri
  LAB_TABLE_ACCOUNTS: 'Accounts'
  LAB_TABLE_OPERATIONS: 'Operations'
  LAB_TABLE_STEPS: 'OperationSteps'
  LAB_TABLE_EVIDENCE: 'Evidence'
  LAB_TABLE_SESSIONS: 'Sessions'
  EXPENSES_APP_NAME: 'glasscliff-expenses'
  EXPENSES_DISPLAY_NAME: 'Glasscliff Expenses'
  EXPENSES_OIDC_AUTHORITY: oktaAuthority
  EXPENSES_OIDC_CLIENT_ID: expensesOidcClientId
  EXPENSES_OIDC_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${kvUri}secrets/expenses-oidc-client-secret)'
  EXPENSES_OIDC_REDIRECT_URI: 'https://${webAppPublicHostName}/labs/identity/expenses/auth/callback'
  EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI: 'https://${webAppPublicHostName}/labs/identity/expenses'
  // No 'groups': the default custom authorization server rejects scopes it does not define.
  EXPENSES_OIDC_SCOPES: 'openid profile email offline_access'
  // Milestone 3: Expenses login reads Accounts and writes Sessions with wetcliff's identity.
  LAB_STORAGE_ACCOUNT: storageAccountName
  OKTA_ORG_URL: oktaOrgUrl
  OKTA_EXPENSES_APP_ID: oktaExpensesAppId
  // Milestone 6: the dashboard's "Run one yourself" panel.
  DEMO_ENABLED: string(demoEnabled)
  // Milestone 9: the reconciliation page. Reads LAB_API_BASE_URL + LAB_OPERATOR_KEY.
  RECON_ENABLED: string(reconEnabled)
}

// A resource cannot be deployed into another resource group directly, so the
// merge runs as a module scoped to the web app's resource group.
module webAppSettings 'modules/webapp-appsettings-merge.bicep' = if (updateExistingWebAppSettings) {
  name: 'merge-appsettings-${take(uniqueString(webAppName), 6)}'
  scope: resourceGroup(webAppResourceGroupName)
  params: {
    webAppName: webAppName
    currentSettings: list('${existingWebApp.id}/config/appsettings', '2023-12-01').properties
    settingsToMerge: webAppSettingsDelta
  }
  dependsOn: [
    kvSecrets
  ]
}

// Optional: let the existing site resolve its Key Vault references.
resource webAppKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppManagedIdentityPrincipalId)) {
  scope: keyVault
  name: guid(keyVault.id, webAppManagedIdentityPrincipalId, 'secretsUser')
  properties: {
    principalId: webAppManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleKeyVaultSecretsUser
  }
}

// Milestone 3: Expenses login on the existing site. Least privilege, per table:
// read Accounts (the SCIM-provisioned account authorizes the login) and
// read/write Sessions (one row per login; SCIM deletes them on deactivation).
resource accountsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' existing = {
  parent: tableService
  name: 'Accounts'
}

resource sessionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' existing = {
  parent: tableService
  name: 'Sessions'
}

resource webAppAccountsReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppManagedIdentityPrincipalId)) {
  scope: accountsTable
  name: guid(storageAccount.id, 'Accounts', webAppManagedIdentityPrincipalId, 'tableDataReader')
  properties: {
    principalId: webAppManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleStorageTableDataReader
  }
  dependsOn: [
    storageTables
  ]
}

resource webAppSessionsWriteRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppManagedIdentityPrincipalId)) {
  scope: sessionsTable
  name: guid(storageAccount.id, 'Sessions', webAppManagedIdentityPrincipalId, 'tableDataContributor')
  properties: {
    principalId: webAppManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleStorageTableDataContributor
  }
  dependsOn: [
    storageTables
  ]
}

// Milestone 4: the public dashboard reads replay files from the private
// 'scenarios' container. Scoped to that container only, not 'evidence'.
resource scenariosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' existing = {
  parent: blobService
  name: 'scenarios'
}

resource webAppScenariosReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(webAppManagedIdentityPrincipalId)) {
  scope: scenariosContainer
  name: guid(storageAccount.id, 'scenarios', webAppManagedIdentityPrincipalId, 'blobDataReader')
  properties: {
    principalId: webAppManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleStorageBlobDataReader
  }
  dependsOn: [
    blobContainers
  ]
}

// Optional: an operator/deployer identity that can rotate lab secrets.
resource kvAdministratorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultAdministratorObjectId)) {
  scope: keyVault
  name: guid(keyVault.id, keyVaultAdministratorObjectId, 'secretsOfficer')
  properties: {
    principalId: keyVaultAdministratorObjectId
    principalType: keyVaultAdministratorPrincipalType
    roleDefinitionId: roleKeyVaultSecretsOfficer
  }
}

// ---------------------------------------------------------------- outputs ----
// Output names are not usable as symbols in Bicep, so shared URLs are vars.
var functionAppHostName = functionApp.properties.defaultHostName
var lifecycleApiBaseUrl = 'https://${functionAppHostName}/api/lifecycle'
var scimEndpointUrl = 'https://${functionAppHostName}/api/scim/v2'
var healthCheckUrl = 'https://${functionAppHostName}/api/lifecycle/health'

output webAppUrl string = webAppUrl
output webAppHostName string = webAppHostName
output webAppPublicHostName string = webAppPublicHostName

output functionAppName string = functionApp.name
output functionAppHostName string = functionAppHostName
output functionIdentityPrincipalId string = functionIdentity.properties.principalId
output functionIdentityClientId string = functionIdentity.properties.clientId

output lifecycleApiBaseUrl string = lifecycleApiBaseUrl
output scimEndpointUrl string = scimEndpointUrl
output oktaEventWebhookUrl string = '${lifecycleApiBaseUrl}/events/okta'
output healthCheckUrl string = healthCheckUrl

// Secrets are not emitted as outputs (they would land in deployment history).
output secretRetrievalCommands array = [
  'az keyvault secret show --vault-name ${keyVaultName} --name scim-bearer-token --query value -o tsv'
  'az keyvault secret show --vault-name ${keyVaultName} --name operator-api-key --query value -o tsv'
  'On redeploy: -p scimBearerToken=<value> operatorApiKey=<value> so the generated secrets are not replaced.'
]

output keyVaultName string = keyVault.name
output keyVaultUri string = kvUri
output storageAccountName string = storageAccount.name
output tableNames array = tableNames
output evidenceContainerUrl string = 'https://${storageAccountName}.blob.${storageSuffix}/evidence'
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output logAnalyticsWorkspaceName string = logAnalytics.name

output firstMilestoneChecklist array = [
  '1. Rotate placeholders: az keyvault secret set --vault-name ${keyVaultName} --name okta-api-token --value <token>  (also okta-client-secret / expenses-oidc-client-secret if left empty). Then restart the Function App so Key Vault references refresh.'
  '2. Deploy the Function App package (az functionapp deployment source config-zip), then hit ${healthCheckUrl} and expect 200.'
  '3. In Okta, create the Glasscliff Expenses SCIM connector app. Base URL: ${scimEndpointUrl}  API token: az keyvault secret show --vault-name ${keyVaultName} --name scim-bearer-token --query value -o tsv'
  '4. Click "Test Connector Configuration" — /ServiceProviderConfig must return 200.'
  '5. Provisioning tab: enable Create Users, Update Attributes, Deactivate Users.'
  '6. Create ONE test employee in Okta and assign them to Glasscliff Expenses.'
  '7. Confirm a row appears in the Accounts table and a sanitized transcript in the evidence container.'
  '8. Store the Okta app instance id (0oa...) in the oktaExpensesAppId parameter and redeploy, passing scimBearerToken and operatorApiKey explicitly so they are not regenerated.'
]

output oktaTenantNote string = 'The Okta test tenant is not an Azure resource. Create it at developer.okta.com or via the Okta Org Signup API from GitHub Actions, then supply oktaOrgUrl / oktaApiToken / oktaClientId / oktaClientSecret as parameters. Nothing else in this lab works until that org exists.'

output deploymentNote string = 'Existing App Service "${webAppName}" in RG "${webAppResourceGroupName}" was NOT recreated. ${updateExistingWebAppSettings ? 'Its app settings were merged with the lab settings; settings not listed were preserved.' : 'App settings were left untouched; apply the lab settings manually.'}${empty(webAppManagedIdentityPrincipalId) ? ' Assign a system identity to it and pass webAppManagedIdentityPrincipalId if you want its Key Vault references to resolve.' : ''}'
