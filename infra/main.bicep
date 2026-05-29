targetScope = 'resourceGroup'

@minLength(1)
@maxLength(64)
@description('azd environment name.')
param environmentName string

@description('Azure region for the resource group and storage account.')
@metadata({
  azd: {
    type: 'location'
  }
})
param location string

@description('Static Web Apps SKU. Standard is recommended for production and advanced auth options.')
@allowed([
  'Free'
  'Standard'
])
param staticWebAppSku string = 'Free'

@description('Azure OpenAI endpoint, for example https://YOUR-RESOURCE.openai.azure.com')
param azureOpenAIEndpoint string = ''

@secure()
@description('Azure OpenAI API key.')
param azureOpenAIApiKey string = ''

@description('Optional advisor endpoint. Leave empty to use Azure OpenAI endpoint.')
param advisorEndpoint string = ''

@secure()
@description('Optional advisor API key. Leave empty to use Azure OpenAI API key.')
param advisorApiKey string = ''

@description('Advisor route hint.')
param advisorApiRoute string = 'openai_v1'

@description('Realtime deployment name.')
param realtimeDeployment string = 'gpt-realtime-1.5'

@description('Realtime noise reduction mode.')
param realtimeNoiseReduction string = 'far_field'

@description('Advisor deployment name.')
param advisorDeployment string = 'grok-4-20-non-reasoning'

@description('Text fallback deployment name.')
param avatarTextDeployment string = 'gpt-5.4-nano'

@description('Realtime input transcription deployment name.')
param transcriptionDeployment string = 'gpt-4o-mini-transcribe'

@secure()
@description('Secret used to sign ZatsuCoach email/password auth session cookies. Use at least 32 random characters.')
param zatsucoachAuthSecret string = ''

@description('Demo account email address for email/password login.')
param zatsucoachDemoEmail string = ''

@secure()
@description('PBKDF2 password hash for the demo email/password login account.')
param zatsucoachDemoPasswordHash string = ''

@description('Comma-separated emails that can access developer-only controls.')
param zatsucoachDeveloperEmails string = 'developer@example.com'

var resourceToken = toLower(uniqueString(resourceGroup().id, environmentName, location))
var staticWebAppName = 'stapp-zatsucoach-${resourceToken}'
var storageAccountName = 'stzatsu${take(resourceToken, 17)}'
var sessionsTableName = 'ZatsucoachSessions'
var itemsTableName = 'ZatsucoachItems'
var diagnosticsTableName = 'ZatsucoachDiagnostics'
var tags = {
  'azd-env-name': environmentName
  app: 'zatsucoach-mvp'
}
var staticWebAppTags = union(tags, {
  'azd-service-name': 'web'
})

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource sessionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: sessionsTableName
}

resource itemsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: itemsTableName
}

resource diagnosticsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: diagnosticsTableName
}

resource staticWebApp 'Microsoft.Web/staticSites@2022-09-01' = {
  name: staticWebAppName
  location: location
  tags: staticWebAppTags
  sku: {
    name: staticWebAppSku
    tier: staticWebAppSku
  }
  properties: {
    buildProperties: {
      appLocation: '/'
      apiLocation: 'api'
      outputLocation: ''
      appBuildCommand: ''
      apiBuildCommand: ''
    }
  }
}

var storageKeys = storage.listKeys().keys
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storageKeys[0].value};EndpointSuffix=${environment().suffixes.storage}'

resource staticWebAppSettings 'Microsoft.Web/staticSites/config@2022-09-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    AZURE_OPENAI_ENDPOINT: azureOpenAIEndpoint
    AZURE_OPENAI_API_KEY: azureOpenAIApiKey
    ADVISOR_ENDPOINT: advisorEndpoint
    ADVISOR_API_KEY: advisorApiKey
    ADVISOR_API_ROUTE: advisorApiRoute
    REALTIME_DEPLOYMENT: realtimeDeployment
    REALTIME_NOISE_REDUCTION: realtimeNoiseReduction
    ADVISOR_DEPLOYMENT: advisorDeployment
    AVATAR_TEXT_DEPLOYMENT: avatarTextDeployment
    TRANSCRIPTION_DEPLOYMENT: transcriptionDeployment
    ENABLE_TRANSCRIBE_DIAGNOSTIC: 'false'
    ZATSUCOACH_LOG_STORAGE_CONNECTION_STRING: storageConnectionString
    ZATSUCOACH_LOG_SESSIONS_TABLE: sessionsTable.name
    ZATSUCOACH_LOG_ITEMS_TABLE: itemsTable.name
    ZATSUCOACH_DIAGNOSTIC_EVENTS_TABLE: diagnosticsTable.name
    ZATSUCOACH_AUTH_SECRET: zatsucoachAuthSecret
    ZATSUCOACH_DEMO_EMAIL: zatsucoachDemoEmail
    ZATSUCOACH_DEMO_PASSWORD_HASH: zatsucoachDemoPasswordHash
    ZATSUCOACH_DEVELOPER_EMAILS: zatsucoachDeveloperEmails
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = resourceGroup().name
output AZURE_STATIC_WEB_APP_NAME string = staticWebApp.name
output AZURE_STATIC_WEB_APP_URL string = 'https://${staticWebApp.properties.defaultHostname}'
output AZURE_STORAGE_ACCOUNT_NAME string = storage.name
