const fs = require('fs')

const SQL_TEMPLATES = {
  organisations: 'INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated, published) VALUES\n',
  delinkedCalc: 'INSERT INTO public."delinkedCalculation" ("applicationId", "calculationId", sbi, frn, "paymentBand1", "paymentBand2", "paymentBand3", "paymentBand4", "percentageReduction1", "percentageReduction2", "percentageReduction3", "percentageReduction4", "progressiveReductions1", "progressiveReductions2", "progressiveReductions3", "progressiveReductions4", "totalProgressiveReduction", "referenceAmount", "totalDelinkedPayment", "paymentAmountCalculated", "datePublished", "updated") VALUES\n',
  d365: 'INSERT INTO public.d365 ("calculationId", "paymentPeriod", "paymentReference", "marketingYear", "paymentAmount", "transactionDate", "datePublished") VALUES\n'
}

const oneMinuteInMS = 60000
const statementDelayInDays = 3

function validateArgs () {
  const args = process.argv.slice(2)
  const recordCount = parseInt(args[0])
  const separate = args[1] ? args[1].toLowerCase() === 'true' : false

  if (isNaN(recordCount) || recordCount <= 0) {
    console.error('Please provide a valid positive number for record count')
    process.exit(1)
  }

  return { recordCount, separate }
}

function writeFile (filename, content, isAppend = false) {
  try {
    if (isAppend) {
      fs.appendFileSync(filename, content)
    } else {
      fs.writeFileSync(filename, content)
    }
  } catch (error) {
    console.error(`Error writing to ${filename}:`, error)
    throw error
  }
}

function getTimestampsForSql () {
  const now = new Date()
  now.setDate(now.getDate() - statementDelayInDays)
  const updatedIso = now.toISOString()
  const datePublishedIso = new Date(now.getTime() - oneMinuteInMS).toISOString()
  return { updatedIso, datePublishedIso, transactionDateIso: updatedIso }
}

function generateSqlStatements (totalRecords, separateFiles) {
  console.log(`Generating ${totalRecords} records. Separate files: ${separateFiles}`)

  try {
    if (separateFiles) {
      writeFile('organisations.sql', '')
      writeFile('delinkedCalculations.sql', '')
      writeFile('d365.sql', '')
    } else {
      writeFile('combined_inserts.sql', '')
    }

    const batchSize = 10000
    let recordsProcessed = 0

    while (recordsProcessed < totalRecords) {
      let organisationsSql = SQL_TEMPLATES.organisations
      let delinkedCalcSql = SQL_TEMPLATES.delinkedCalc
      let d365Sql = SQL_TEMPLATES.d365

      const batchEnd = Math.min(recordsProcessed + batchSize, totalRecords)
      const timestamps = getTimestampsForSql()

      for (let i = recordsProcessed + 1; i <= batchEnd; i++) {
        const sbi = 123000000 + i
        const frn = (1234000000 + i).toString()
        const calculationId = 987000000 + i
        const paymentReference = `PY${String(i).padStart(7, '0')}`
        const name = `Performance farm${i}`.replace(/'/g, "''")
        const emailAddress = 'documents.performance.test@gmail.com'
        const applicationId = 1234567 + i

        organisationsSql += `(${sbi}, 'Street', 'Area', 'District', 'City', 'County', 'AA1 1BB', '${emailAddress}', ${frn}, '${name}', '${timestamps.updatedIso}', NULL)`

        delinkedCalcSql += `(${applicationId}, ${calculationId}, ${sbi}, '${frn}', '30000', '50000', '150000', '99999999.99', '50.00', '55.00', '65.00', '70.00', '15000.00', '11000.00', '65000.00', '35000.00', '126000.00', '2000000.00', '75000.00', '37500.00', '${timestamps.datePublishedIso}', '${timestamps.updatedIso}')`

        d365Sql += `(${calculationId}, 'Q4-24', '${paymentReference}', 2024, '37500.00', '${timestamps.transactionDateIso}', null)`

        if (i < batchEnd) {
          organisationsSql += ',\n'
          delinkedCalcSql += ',\n'
          d365Sql += ',\n'
        }
      }

      organisationsSql += ';\n\n'
      delinkedCalcSql += ';\n\n'
      d365Sql += ';\n\n'

      if (separateFiles) {
        writeFile('organisations.sql', organisationsSql, true)
        writeFile('delinkedCalculations.sql', delinkedCalcSql, true)
        writeFile('d365.sql', d365Sql, true)
      } else {
        writeFile('combined_inserts.sql', organisationsSql + delinkedCalcSql + d365Sql, true)
      }

      recordsProcessed = batchEnd
      console.log(`Processed ${recordsProcessed} records of ${totalRecords}`)
    }

    console.log('SQL generation completed successfully')
  } catch (error) {
    console.error('Error generating SQL:', error)
    process.exit(1)
  }
}

const { recordCount, separate } = validateArgs()
generateSqlStatements(recordCount, separate)
