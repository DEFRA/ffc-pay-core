const { createConnection } = require('./db-connection')

module.exports = createConnection(process.env.POSTGRES_TEST_DATA_DB)