const path = require('path')
const { createLocalConnection } = require('../database/local-db-connection')
const { parseCsv } = require('../util/parse-csv')

const CSV_FILE = path.resolve(__dirname, '..', 'agreements.csv')
const TABLE_NAME = 'agreements'
const BATCH_SIZE = 5000

async function ensureTable (connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS public."${TABLE_NAME}" (
      frn bigint NOT NULL,
      "schemeId" integer NOT NULL,
      "agreementNumber" character varying(50) NOT NULL,
      CONSTRAINT "${TABLE_NAME}_pkey" PRIMARY KEY (frn, "schemeId", "agreementNumber")
    )
  `)
}

async function loadAgreements () {
  console.log(`Parsing ${CSV_FILE}...`)
  const rows = parseCsv(CSV_FILE)
  console.log(`Parsed ${rows.length} agreement rows from CSV`)

  if (rows.length === 0) {
    console.log('No agreements to load.')
    return
  }

  const connection = await createLocalConnection({ applicationName: 'ffc_pay_load_agreements' })

  try {
    await ensureTable(connection)

    const { rows: existing } = await connection.query(`SELECT COUNT(*)::int AS count FROM public."${TABLE_NAME}"`)
    if (existing[0].count >= rows.length) {
      console.log(`Agreements table already contains ${existing[0].count} rows; skipping load.`)
      return
    }

    await connection.query(`TRUNCATE TABLE public."${TABLE_NAME}"`)

    let inserted = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const params = []
      const placeholders = batch.map((row, index) => {
        const offset = index * 3
        params.push(row.frn, row.schemeId, row.agreementNumber)
        return `($${offset + 1}, $${offset + 2}, $${offset + 3})`
      }).join(', ')

      const result = await connection.query(
        `
        INSERT INTO public."${TABLE_NAME}" (frn, "schemeId", "agreementNumber")
        VALUES ${placeholders}
        ON CONFLICT (frn, "schemeId", "agreementNumber") DO NOTHING
        `,
        params
      )
      inserted += result.rowCount
    }

    const { rows: total } = await connection.query(`SELECT COUNT(*)::int AS count FROM public."${TABLE_NAME}"`)
    console.log(`Loaded ${inserted} new agreements into public."${TABLE_NAME}" (table total: ${total[0].count})`)
  } catch (error) {
    console.error('Failed to load agreements:', error.message)
    process.exit(1)
  } finally {
    await connection.close()
  }
}

loadAgreements()
