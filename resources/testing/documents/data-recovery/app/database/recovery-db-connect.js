const { createRecoveryConnection } = require('./recovery-db-connection')

module.exports = createRecoveryConnection({ database: process.env.RECOVERY_DB_NAME })
