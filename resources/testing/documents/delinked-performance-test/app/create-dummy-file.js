const fs = require('fs')

const SQL_TEMPLATES = {
  organisations: 'INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated) VALUES\n',
  delinkedCalc: 'INSERT INTO public."delinkedCalculation" ("applicationId", "calculationId", sbi, frn, "paymentBand1", "paymentBand2", "paymentBand3", "paymentBand4", "percentageReduction1", "percentageReduction2", "percentageReduction3", "percentageReduction4", "progressiveReductions1", "progressiveReductions2", "progressiveReductions3", "progressiveReductions4", "totalProgressiveReduction", "referenceAmount", "totalDelinkedPayment", "paymentAmountCalculated", "datePublished", updated) VALUES\n',
  d365: 'INSERT INTO public.d365 ("calculationId", "paymentPeriod", "paymentReference", "paymentAmount", "transactionDate") VALUES\n'
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
        d365Sql += `(${calculationId}, '2024', '${paymentReference}', 37500, '${currentDate}')`

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
