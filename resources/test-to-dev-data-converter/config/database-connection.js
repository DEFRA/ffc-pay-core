const { Client } = require('pg')

class DatabaseConnection {
    constructor(config) {
        // Remove @hostname from username if it exists
        const username = config.username.split('@')[0]
        const host = config.host

        this.config = {
            ...config,
            user: username,  // pg client uses 'user' instead of 'username'
            host: host,
            ssl: {
                rejectUnauthorized: true
            },
            connectionTimeoutMillis: 20000,
            keepAlive: true
        }
        this.client = null
        
        console.log('\nInitializing connection with config:', {
            host: this.config.host,
            database: this.config.database,
            user: this.config.user,
            port: this.config.port
        })
    }

    async connect() {
        try {
            console.log('\nConfiguring database client...')
            this.client = new Client(this.config)
            console.log('✓ Client configured with SSL settings')

            console.log('\nAttempting database connection...')
            await this.client.connect()
            console.log(`✓ Successfully connected to: ${this.config.database} (${this.config.host})`)
        } catch (error) {
            console.error('\n❌ Connection failed with details:', {
                error: error.message,
                code: error.code,
                host: this.config.host,
                database: this.config.database,
                user: this.config.user
            })
            throw new Error(`Connection failed: ${error.message}`)
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