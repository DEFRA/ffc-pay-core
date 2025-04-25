const { createConnection } = require('./db-connection')

module.exports = createConnection(process.env.POSTGRES_DEV_DATA_DB)