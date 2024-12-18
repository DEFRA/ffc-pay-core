const fs = require('fs')

const SQL_TEMPLATES = {
  organisations: 'INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated) VALUES\n',
  delinkedCalc: 'INSERT INTO public.delinkedCalculation ("applicationId", "calculationId", sbi, frn, "paymentBand1", "paymentBand2", "paymentBand3", "paymentBand4", "percentageReduction1", "percentageReduction2", "percentageReduction3", "percentageReduction4", "progressiveReductions1", "progressiveReductions2", "progressiveReductions3", "progressiveReductions4", "totalProgressiveReduction", "referenceAmount", "totalDelinkedPayment", "paymentAmountCalculated", "datePublished", updated) VALUES\n',
  d365: 'INSERT INTO public.d365 ("calculationId", "paymentPeriod", "paymentReference", "paymentAmount", "transactionDate") VALUES\n'
}

function generateSqlStatements (totalRecords = 250000, separateFiles = false) {
  try {
    if (!Number.isInteger(totalRecords) || totalRecords <= 0) {
      throw new Error('Total records must be a positive integer')
    }

    const batchSize = 10000
    let organisationsSql = SQL_TEMPLATES.organisations
    let delinkedCalcSql = SQL_TEMPLATES.delinkedCalc
    let d365Sql = SQL_TEMPLATES.d365

    console.log(`Starting generation of ${totalRecords} records...`)
    console.time('Generation completed in')

    for (let i = 1; i <= totalRecords; i++) {
      const sbi = 123000000 + i
      const frn = (1234000000 + i).toString()
      const calculationId = 987000000 + i
      const paymentReference = `PY${String(i).padStart(7, '0')}`
      const name = `Performance farm${i}`
      const emailAddress = 'documents.performance.test@gmail.com'
      const applicationId = 1234567 + i
      const currentDate = new Date().toISOString()

      organisationsSql += `(${sbi}, 'Street', 'Area', 'District', 'City', 'County', 'AA1 1BB', '${emailAddress}', ${frn}, '${name}', '${currentDate}')`
      delinkedCalcSql += `(${applicationId}, ${calculationId}, ${sbi}, '${frn}', '30000', '50000', '150000', '99999999.99', '50', '55', '65', '70', '15000', '11000', '65000', '35000', '126000', '2000000', '75000', '37500', '${currentDate}', '${currentDate}')`
      d365Sql += `(${calculationId}, '2024', '${paymentReference}', 37500, '${currentDate}')`

      if (i < totalRecords) {
        organisationsSql += ',\n'
        delinkedCalcSql += ',\n'
        d365Sql += ',\n'
      } else {
        organisationsSql += ';\n'
        delinkedCalcSql += ';\n'
        d365Sql += ';\n'
      }

      if (i % batchSize === 0 || i === totalRecords) {
        try {
          if (separateFiles) {
            fs.appendFileSync('organisations.sql', organisationsSql)
            fs.appendFileSync('delinkedCalculations.sql', delinkedCalcSql)
            fs.appendFileSync('d365.sql', d365Sql)
          } else {
            fs.appendFileSync('combined_inserts.sql', organisationsSql + '\n' + delinkedCalcSql + '\n' + d365Sql + '\n')
          }
          console.log(`Processed ${i} records of ${totalRecords}`)

          if (i < totalRecords) {
            organisationsSql = SQL_TEMPLATES.organisations
            delinkedCalcSql = SQL_TEMPLATES.delinkedCalc
            d365Sql = SQL_TEMPLATES.d365
          }
        } catch (fileError) {
          throw new Error(`Failed to write to file at record ${i}: ${fileError.message}`)
        }
      }
    }

    console.timeEnd('Generation completed in')
    console.log(`Successfully generated ${totalRecords} records in ${separateFiles ? 'separate' : 'combined'} files`)
  } catch (error) {
    console.error('Error generating SQL statements:', error.message)
    process.exit(1)
  }
}

const args = process.argv.slice(2)
const recordCount = parseInt(args[0]) || 250000
const separate = args[1] === 'true'

generateSqlStatements(recordCount, separate)
