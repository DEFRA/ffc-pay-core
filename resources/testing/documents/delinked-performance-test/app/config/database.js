const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity')

function logDbAction (message, data) {
  console.log(`DB CONFIG [${new Date().toISOString()}] - ${message}`, data || '')
}

const hooks = {
  beforeConnect: async (cfg) => {
    logDbAction('Setting up database connection')
    logDbAction('Connection details:', {
      host: cfg.host,
      database: cfg.database,
      port: cfg.port,
      usernameProvided: !!cfg.username
    })

    if (!process.env.POSTGRES_DEV_DB_ACCOUNT) {
      logDbAction('WARNING: POSTGRES_DEV_DB_ACCOUNT is not set')
    }
    if (!process.env.AZURE_CLIENT_ID_DEV_DATA) {
      logDbAction('WARNING: AZURE_CLIENT_ID for data service in dev is not set')
    }
    if (!process.env.MICROSOFT_DEV_ENTRA_TENANT_ID) {
      logDbAction('WARNING: MICROSOFT_DEV_ENTRA_TENANT_ID is not set')
    }

    try {
      const dbAuthEndpoint = 'https://ossrdbms-aad.database.windows.net/.default'
      logDbAction('Using Azure AD authentication with endpoint', dbAuthEndpoint)

      const credentialOptions = {}
      if (process.env.AZURE_CLIENT_ID_DEV_DATA) {
        credentialOptions.managedIdentityClientId = process.env.AZURE_CLIENT_ID_DEV_DATA
      }

      if (process.env.MICROSOFT_DEV_ENTRA_TENANT_ID) {
        credentialOptions.tenantId = process.env.MICROSOFT_DEV_ENTRA_TENANT_ID
      }

      logDbAction('Creating DefaultAzureCredential with options:', credentialOptions)
      const credential = new DefaultAzureCredential(credentialOptions)

      try {
        const tokenResponse = await credential.getToken(dbAuthEndpoint)
        logDbAction('Successfully acquired token', { expiresOn: tokenResponse.expiresOn })
      } catch (tokenError) {
        logDbAction('Failed to acquire token', tokenError.message)
        throw tokenError
      }

      const tokenProvider = getBearerTokenProvider(
        credential,
        dbAuthEndpoint
      )

      logDbAction('TokenProvider created successfully')

      cfg.username = process.env.POSTGRES_DEV_DB_ACCOUNT
      logDbAction('Using AAD username:', cfg.username || 'NOT PROVIDED - THIS WILL CAUSE FAILURE')

      cfg.password = tokenProvider
      cfg.dialectOptions = {
        ...cfg.dialectOptions,
        ssl: {
          require: true,
          rejectUnauthorized: true
        },
        connectTimeout: 30000 // 30 seconds
      }

      logDbAction('Connection configured with token provider and SSL')
    } catch (error) {
      logDbAction('Error setting up Azure authentication', error.message)
      logDbAction('Error stack trace', error.stack)
      throw error
    }
  }
}

const retry = {
  backoffBase: 500,
  backoffExponent: 1.1,
  match: [/SequelizeConnectionError/, /TimeoutError/, /ConnectionError/],
  max: 5,
  name: 'connection',
  timeout: 30000
}

const config = {
  database: process.env.POSTGRES_DEV_DATA_DB,
  dialect: 'postgres',
  dialectOptions: {
    ssl: true,
    connectTimeout: 30000 // 30 seconds
  },
  hooks,
  host: process.env.POSTGRES_DEV_DB_HOST,
  port: process.env.POSTGRES_PORT || 5486,
  logging: (msg) => logDbAction('SQL Query', msg),
  retry,
  schema: process.env.POSTGRES_SCHEMA_NAME || 'public',
  username: process.env.POSTGRES_DEV_DB_ACCOUNT || process.env.POSTGRES_DEV_DB_ADMIN || process.env.POSTGRES_DEV_DB_USER,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
}

module.exports = config
