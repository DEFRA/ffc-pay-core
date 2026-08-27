module.exports = {
  scenario: 'test-to-dev',
  sourceEnvironment: 'test',
  targetEnvironment: 'dev',
  dump: {
    outputDir: 'test-dumps',
    pattern: '_full.sql'
  },
  database: {
    port: 5432,
    ssl: true,
    environments: {
      recovery: {
        suffix: '-recovery',
        hostEnvVar: 'RECOVERY_DB_HOST',
        adminEnvVar: 'RECOVERY_DB_ADMIN',
        passwordEnvVar: 'RECOVERY_DB_PASSWORD',
        tenantEnvVar: 'RECOVERY_DB_TENANT',
        useAzureAd: false
      }
    }
  }
}
