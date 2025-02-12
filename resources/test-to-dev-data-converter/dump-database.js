const { spawn } = require('child_process')
const { selectSource, passwordPrompt } = require('./select-database')

async function runPgDump() {
    // Get the selected source config (prompts for selection if run from terminal)
    const sourceConfig = await selectSource()
    const { host, port, username, database } = sourceConfig

        // Prompt for the password using the password prompt from inquirer/prompts
    const dbPassword = await passwordPrompt()

    // File name for the dump
    const dumpFile = `${database}-dump.sql`

    // Set up environment for the spawn, including PGPASSWORD for authentication
    const env = { ...process.env, PGPASSWORD: dbPassword }

    // Build pg_dump arguments
    const args = [
        '-h', host,
        '-p', port.toString(),
        '-U', username,
        '-d', database,
        '-f', dumpFile // output file
    ]

    // Spawn pg_dump
    const pgDump = spawn('pg_dump', args, { env })

    pgDump.stdout.on('data', data => {
        console.log(`stdout: ${data}`)
    })

    pgDump.stderr.on('data', data => {
        console.error(`stderr: ${data}`)
    })

    pgDump.on('close', code => {
        if (code !== 0) {
            console.error(`pg_dump process exited with code ${code}`)
        } else {
            console.log(`pg_dump successfully completed. Dump saved to ${dumpFile}`)
        }
    })
}

runPgDump().catch(err => {
    console.error('Error occurred:', err)
})