const { Client } = require('pg')
const { DefaultAzureCredential } = require('@azure/identity')

class DatabaseConnection {
    constructor(config) {
        this.config = config
        this.client = null
        console.log('\nInitializing connection with config:', {
            host: config.host,
            database: config.database,
            username: config.username,
            port: config.port,
            ssl: config.ssl ? 'enabled' : 'disabled'
        })
    }

    async connect() {
        try {
            console.log('\nAttempting Azure authentication...')
            const credential = new DefaultAzureCredential()
            const accessToken = await credential.getToken(
                'https://ossrdbms-aad.database.windows.net',
                { requestOptions: { timeout: 1000 } }
            )
            console.log('✓ Azure token acquired')

            console.log('\nConfiguring database client...')
            this.client = new Client({
                ...this.config,
                password: accessToken.token,
                ssl: {
                    rejectUnauthorized: true,
                    requestCert: true
                },
                connectionTimeoutMillis: 10000
            })
            console.log('✓ Client configured with SSL and timeout settings')

            console.log('\nAttempting database connection...')
            await this.client.connect()
            console.log(`✓ Successfully connected to: ${this.config.database} (${this.config.host})`)
        } catch (error) {
            console.error('\n❌ Connection failed with details:', {
                error: error.message,
                code: error.code,
                host: this.config.host,
                database: this.config.database,
                username: this.config.username
            })
            throw new Error(`Azure connection failed: ${error.message}`)
        }
    }

    async query(sql, params = []) {
        if (!this.client) {
            throw new Error('No active database connection')
        }
        try {
            console.log('\nExecuting query...')
            const result = await this.client.query(sql, params)
            console.log(`✓ Query completed successfully (${result.rowCount} rows)`)
            return result
        } catch (error) {
            console.error('\n❌ Query failed:', {
                error: error.message,
                code: error.code,
                sql: sql.substring(0, 100) + '...'
            })
            throw new Error(`Query failed: ${error.message}`)
        }
    }

    async disconnect() {
        try {
            await this.client.end()
            console.log(`Disconnected from database: ${this.client.database}`)
        } catch (error) {
            console.error(`Error disconnecting: ${error.message}`)
        }
    }

    static async createConnection(config) {
        const connection = new DatabaseConnection(config)
        await connection.connect()
        return connection
    }
}

module.exports = DatabaseConnection