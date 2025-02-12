const databases = [
  'ffc-doc-statement-data',
  'ffc-doc-statement-constructor',
  'ffc-doc-statement-generator',
  'ffc-doc-statement-publisher'
]

const environments = {
  test: {
    username: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD,
    host: process.env.TEST_DB_HOST,
    port: 5432,
    suffix: 'test'
  },
  dev: {
    username: process.env.DEV_DB_USER,
    password: process.env.DEV_DB_PASSWORD,
    host: process.env.DEV_DB_HOST,
    port: 5432,
    suffix: 'dev'
  }
}

const createDbConfig = (dbName, envConfig) => ({
  username: envConfig.username,
  password: envConfig.password,
  host: envConfig.host,
  port: envConfig.port,
  database: `${dbName}-${envConfig.suffix}`,
  connectionName: dbName
})

const createEnvironmentMapping = (environmentConfig) => 
  databases.reduce((acc, dbName) => {
    acc[dbName] = createDbConfig(dbName, environmentConfig)
    return acc
  }, {})

  const validateConfigs = (_configs) => {
    const missingVars = {
      test: [],
      dev: []
    }
    if (!process.env.TEST_DB_USER) missingVars.test.push('TEST_DB_USER')
    if (!process.env.TEST_DB_HOST) missingVars.test.push('TEST_DB_HOST')
    
    if (!process.env.DEV_DB_USER) missingVars.dev.push('DEV_DB_USER')
    if (!process.env.DEV_DB_HOST) missingVars.dev.push('DEV_DB_HOST')
  
    const missingEnvs = Object.entries(missingVars)
      .filter(([_, vars]) => vars.length > 0)
      .map(([env, vars]) => `${env}: ${vars.join(', ')}`)
  
    if (missingEnvs.length > 0) {
      throw new Error(
        'Missing required environment variables:\n' +
        missingEnvs.join('\n') +
        '\n\nPlease set these environment variables before running the application.'
      )
    }
  }

validateConfigs(environments)

module.exports = {
  source: createEnvironmentMapping(environments.test),
  destination: createEnvironmentMapping(environments.dev)
}