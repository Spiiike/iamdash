@description('Name of the existing App Service.')
param webAppName string

@secure()
@description('The site\'s current app settings, read by the parent template.')
param currentSettings object

@description('Settings to add or overwrite. Existing settings not listed here are preserved.')
param settingsToMerge object

resource site 'Microsoft.Web/sites@2023-12-01' existing = {
  name: webAppName
}

resource appSettings 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: site
  name: 'appsettings'
  properties: union(currentSettings, settingsToMerge)
}
