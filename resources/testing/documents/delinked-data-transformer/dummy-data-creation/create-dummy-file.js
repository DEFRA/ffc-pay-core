const fs = require('fs')
const path = require('path')

const SQL_TEMPLATES = {
  organisations: 'INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated) VALUES\n',
  delinkedCalc: 'INSERT INTO public."delinkedCalculation" ("applicationId", "calculationId", sbi, frn, "paymentBand1", "paymentBand2", "paymentBand3", "paymentBand4", "percentageReduction1", "percentageReduction2", "percentageReduction3", "percentageReduction4", "progressiveReductions1", "progressiveReductions2", "progressiveReductions3", "progressiveReductions4", "totalProgressiveReduction", "referenceAmount", "totalDelinkedPayment", "paymentAmountCalculated", "datePublished", updated) VALUES\n',
  d365: 'INSERT INTO public.d365 ("calculationId", "paymentPeriod", "paymentReference", "paymentAmount", "marketingYear", "transactionDate") VALUES\n'
}

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

function writeFile (filePath, content, isAppend = false) {
  try {
    if (isAppend) {
      fs.appendFileSync(filePath, content)
    } else {
      fs.writeFileSync(filePath, content)
    }
  } catch (error) {
    console.error(`Error writing to ${filePath}:`, error)
    throw error
  }
}

function generateSqlStatements (totalRecords, separateFiles) {
  console.log(`Generating ${totalRecords} records. Separate files: ${separateFiles}`)

  const dumpDir = path.resolve(process.cwd(), '../dummy-inserts')
  if (!fs.existsSync(dumpDir)) {
    fs.mkdirSync(dumpDir, { recursive: true })
  }

  try {
    if (separateFiles) {
      writeFile(path.join(dumpDir, 'organisations.sql'), '')
      writeFile(path.join(dumpDir, 'delinkedCalculations.sql'), '')
      writeFile(path.join(dumpDir, 'd365.sql'), '')
    } else {
      writeFile(path.join(dumpDir, 'combined_inserts.sql'), '')
    }

    const batchSize = 10000
    let recordsProcessed = 0

    while (recordsProcessed < totalRecords) {
      let organisationsSql = SQL_TEMPLATES.organisations
      let delinkedCalcSql = SQL_TEMPLATES.delinkedCalc
      let d365Sql = SQL_TEMPLATES.d365

      const batchEnd = Math.min(recordsProcessed + batchSize, totalRecords)

      for (let i = recordsProcessed + 1; i <= batchEnd; i++) {
        const sbi = 123000000 + i
        const frn = (1234000000 + i).toString()
        const calculationId = 987000000 + i
        const paymentReference = `PY${String(i).padStart(7, '0')}`
        const name = `Performance farm${i}`
        const emailAddress = 'documents.performance.test@gmail.com'
        const applicationId = 1234567 + i
        const now = new Date()
        const currentDate = now.toISOString()
        const updatedDate = new Date(now.getTime() + 60000).toISOString()

        organisationsSql += `(${sbi}, 'Street', 'Area', 'District', 'City', 'County', 'AA1 1BB', '${emailAddress}', ${frn}, '${name}', '${currentDate}')`
        delinkedCalcSql += `(${applicationId}, ${calculationId}, ${sbi}, '${frn}', '30000', '50000', '150000', '99999999.99', '50', '55', '65', '70', '15000', '11000', '65000', '35000', '126000', '2000000', '75000', '37500', '${currentDate}', '${updatedDate}')`
        d365Sql += `(${calculationId}, '2024', '${paymentReference}', 37500, '2024', '${currentDate}')`

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
        writeFile(path.join(dumpDir, 'organisations.sql'), organisationsSql, true)
        writeFile(path.join(dumpDir, 'delinkedCalculations.sql'), delinkedCalcSql, true)
        writeFile(path.join(dumpDir, 'd365.sql'), d365Sql, true)
      } else {
        writeFile(path.join(dumpDir, 'combined_inserts.sql'), organisationsSql + delinkedCalcSql + d365Sql, true)
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

if (require.main === module) {
  const { recordCount, separate } = validateArgs()
  generateSqlStatements(recordCount, separate)
}

module.exports = {
  generateSqlStatements
}