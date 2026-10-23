const { createLocalConnection } = require('../database/local-db-connection')
const { createRecoveryConnection } = require('../database/recovery-db-connection')

const VALID_MODES = ['local', 'hosted']

function getTargetMode () {
  const mode = process.env.RECOVERY_TARGET_MODE || 'local'
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid RECOVERY_TARGET_MODE "${mode}". Must be one of: ${VALID_MODES.join(', ')}`)
  }
  return mode
}

function getTargetSchema () {
  return process.env.RECOVERY_TARGET_SCHEMA || 'public'
}

function getHostedTargetDatabase () {
  return process.env.RECOVERY_TARGET_DATABASE || process.env.RECOVERY_DB_NAME
}

async function createTargetConnection (options = {}) {
  const mode = getTargetMode()

  if (mode === 'local') {
    return createLocalConnection({
      applicationName: options.applicationName || 'ffc_pay_recovery_target_writer',
      ...options
    })
  }

  return createRecoveryConnection({
    database: getHostedTargetDatabase(),
    applicationName: options.applicationName || 'ffc_pay_recovery_target_writer',
    ...options
  })
}

module.exports = {
  getTargetMode,
  getTargetSchema,
  getHostedTargetDatabase,
  createTargetConnection
}
