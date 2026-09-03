module.exports = {
  scenario: 'local-test',
  description: 'Transfer a specified source table into a local PostgreSQL target for integration testing',
  sourceEnvironment: 'recovery',
  targetEnvironment: 'local',
  database: {
    port: Number(process.env.LOCAL_POSTGRES_PORT || 5432),
    ssl: false
  }
}
