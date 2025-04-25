const fs = require('fs')
const os = require('os')
const path = require('path')
const { getTestClient } = require('./test-db-connect')
const { getDevClient } = require('./dev-db-connect')
const { mapOrgFaker } = require('../../../map-org-faker')

// This script dumps data from the test database, transforms it, and either writes it to a file or uploads it to the dev database. Not tested yet
async function dumpAndTransform({ toFile = false } = {}) {
  const sourceClient = await getTestClient()
  const destClient = await getDevClient()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-dump-'))
  try {
    const tables = [
      {
        name: 'organisations',
        transformer: mapOrgFaker
      }
      // add more tables here:
      // { name: 'other_table', transformer: mapOtherFaker }
    ]

    for (const { name, transformer } of tables) {
      // 1. Read from test DB
      const { rows } = await sourceClient.query(`SELECT * FROM public."${name}"`)
      // 2. Transform/anonymise
      const transformed = transformer(rows)
      if (toFile) {
        // 3a. Write INSERTs to temp file
        const filePath = path.join(tmpDir, `${name}.sql`)
        const inserts = transformed.map(row => {
          const cols = Object.keys(row).map(c => `"${c}"`).join(', ')
          const vals = Object.values(row)
            .map(v => v === null ? 'NULL' : `'${v.toString().replace(/'/g, "''")}'`)
            .join(', ')
          return `INSERT INTO public."${name}" (${cols}) VALUES (${vals});`
        }).join('\n')
        fs.writeFileSync(filePath, `TRUNCATE TABLE public."${name}" RESTART IDENTITY CASCADE;\n${inserts}\n`)
        console.log(`Dumped transformed ${name} to ${filePath}`)
      } else {
        // 3b. Truncate & upload to dev DB
        await destClient.query(`TRUNCATE TABLE public."${name}" RESTART IDENTITY CASCADE`)
        for (const row of transformed) {
          const cols = Object.keys(row).map(c => `"${c}"`).join(', ')
          const vals = Object.values(row)
            .map(v => v === null ? 'NULL' : `'${v.toString().replace(/'/g, "''")}'`)
            .join(', ')
          await destClient.query(`INSERT INTO public."${name}" (${cols}) VALUES (${vals})`)
        }
        console.log(`Synchronized ${name} to dev database`)
      }
    }
  } finally {
    await sourceClient.end()
    await destClient.end()
  }
}

module.exports = { dumpAndTransform }