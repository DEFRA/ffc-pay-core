module.exports = {
  source: {
    'ffc-doc-statement-data': {
      connectionname: 'ffc-doc-statement-data-test',
      username: 'adminuser@testffcdbssq1001',
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-data-test',
      host: 'testffcdbssq1001.postgres.database.azure.com', // do not leave this in the public repo
      port: 5432
    },
    'ffc-doc-statement-constructor': {
      connectionname: 'ffc-doc-statement-constructor-test',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-constructor-test',
      host: 'constructor.hostname-complete this',
      port: 5432
    },
    'ffc-doc-statement-generator': {
      connectionname: 'ffc-doc-statement-generator-test',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-generator-test',
      host: 'generator.hostname-complete this',
      port: 5432
    },
    'ffc-doc-statement-publisher': {
      connectionname: 'ffc-doc-statement-publisher-test',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-publisher-test',
      host: 'publisher.hostname-complete this',
      port: 5432
    }
  },
  destination: {
    'ffc-doc-statement-data': {
      connectionname: 'ffc-doc-statement-data-dev',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-data-dev',
      host: 'data.hostname-complete this',
      port: 5432
    },
    'ffc-doc-statement-constructor': {
      connectionname: 'ffc-doc-statement-constructor-dev',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-constructor-dev',
      host: 'constructor.hostname-complete this',
      port: 5432
    },
    'ffc-doc-statement-generator': {
      connectionname: 'ffc-doc-statement-generator-dev',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-generator-dev',
      host: 'generator.hostname-complete this',
      port: 5432
    },
    'ffc-doc-statement-publisher': {
      connectionname: 'ffc-doc-statement-publisher-dev',
      username: process.env.SOURCE_DB_USER,
      password: process.env.SOURCE_DB_PASSWORD,
      database: 'ffc-doc-statement-publisher-dev',
      host: 'publisher.hostname-complete this',
      port: 5432
    }
  }
}
