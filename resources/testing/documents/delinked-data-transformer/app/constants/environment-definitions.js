const ENVIRONMENT_DEFINITIONS = {
  dev: {
    suffix: '-dev',
    hostEnvVar: 'POSTGRES_DEV_HOST',
    adminEnvVar: 'POSTGRES_DEV_ADMIN',
    tenantEnvVar: 'DEV_TENANT'
  },
  test: {
    suffix: '-test',
    hostEnvVar: 'POSTGRES_DEV_HOST',
    adminEnvVar: 'POSTGRES_DEV_ADMIN',
    tenantEnvVar: 'DEV_TENANT'
  },
  pre: {
    suffix: '-pre',
    hostEnvVar: 'POSTGRES_PRE_HOST',
    adminEnvVar: 'POSTGRES_PRE_ADMIN',
    tenantEnvVar: 'PRE_TENANT'
  },
  prd: {
    suffix: '-prd',
    hostEnvVar: 'POSTGRES_PRD_HOST',
    adminEnvVar: 'POSTGRES_PRD_ADMIN',
    tenantEnvVar: 'PRD_TENANT'
  },
  recovery: {
    suffix: '-prd',
    hostEnvVar: 'RECOVERY_DB_HOST',
    adminEnvVar: 'RECOVERY_DB_USER',
    passwordEnvVar: 'RECOVERY_DB_PASSWORD',
    useAzureAd: false
  },
  local: {
    suffix: '',
    hostEnvVar: 'LOCAL_POSTGRES_HOST',
    adminEnvVar: 'LOCAL_POSTGRES_ADMIN',
    passwordEnvVar: 'LOCAL_POSTGRES_PASSWORD',
    useAzureAd: false
  }
}
module.exports = ENVIRONMENT_DEFINITIONS
