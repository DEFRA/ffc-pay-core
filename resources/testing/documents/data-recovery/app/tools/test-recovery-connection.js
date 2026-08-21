const { createRecoveryConnection } = require('../database/recovery-db-connection')

async function run () {
  try {
    console.log('Testing recovery database connection...')
    const connection = await createRecoveryConnection()

    const dbResult = await connection.query('SELECT current_database() AS database, current_user AS user')
    console.log('Connected as:', dbResult.rows[0])

    const tableResult = await connection.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `)
    console.log('Public tables:', tableResult.rows.map(row => row.table_name))

    await connection.close()
    console.log('Recovery database connection test passed.')
    process.exit(0)
  } catch (error) {
    console.error('Recovery database connection test failed:', error.message)
    process.exit(1)
  }
}

run()
