const fs = require('fs')
const path = require('path')
const os = require('os')

// Get the user's home directory
const userHome = os.homedir()

const ORGANISATIONS_INSERT_TEMPLATE_SQL = 'INSERT INTO "organisations" ("sbi","addressLine1", "addressLine2", "addressLine3", "city", "county", "postcode", "emailAddress", "frn", "name", "updated") VALUES (SBI_REPLACE,\'123 Main Street\',\'Apt 4B\',\'Building C\',\'London\',\'Greater London\',\'123 AB\',\'richard.cawston@eviden.com\',1102358109,\'Green Acres Farm\',to_date(\'14-FEB-24 01:34:17\',\'DD-MON-YY HH:MI:SS\'));'
const TOTALS_INSERT_TEMPLATE_SQL = 'INSERT INTO "totals" ("sbi", "frn", "agreementNumber", "claimId", "schemeType", "calculationId", "calculationDate", "invoiceNumber", "agreementStart", "agreementEnd", "totalActionPayments", "totalAdditionalPayments", "totalPayments", "updated") VALUES (SBI_REPLACE,1102383147,1655165,1670137,\'SFI-23\',CALCULATION_ID_REPLACE,to_date(\'02-FEB-24 10:55:33\',\'DD-MON-YY HH:MI:SS\'),\'SFIA0103195\',to_date(\'01-NOV-23 12:00:00\',\'DD-MON-YY HH:MI:SS\'),to_date(\'31-OCT-26 12:00:00\',\'DD-MON-YY HH:MI:SS\'),79014.39,1000,80014.39,to_date(\'29-FEB-24 10:59:01\',\'DD-MON-YY HH:MI:SS\'));'
const DAX_INSERT_TEMPLATE_SQL = 'INSERT INTO "dax" ("calculationId", "paymentPeriod", "paymentReference", "paymentAmount", "transactionDate") VALUES (CALCULATION_ID_REPLACE,\'1st November 2023 to 31st January 2024\',\'PAYMENT_REFERENCE_REPLACE\',-3495,to_date(\'06-FEB-24 12:00:00\',\'DD-MON-YY HH:MI:SS\'));'
const DELINKEDCALSULATION_INSERT_TEMPLATE_SQL = 'INSERT INTO "delinkedCalculation" ("applicationId", "calculationId", "sbi", "frn", "paymentBand1", "paymentBand2", "paymentBand3", "paymentBand4", "percentageReduction1", "percentageReduction2", "percentageReduction3", "percentageReduction4", "progressiveReductions1", "progressiveReductions2", "progressiveReductions3", "progressiveReductions4", "referenceAmount", "totalProgressiveReduction", "totalDelinkedPayment", "paymentAmountCalculated") VALUES (APPLICATION_ID_REPLACE,CALCULATION_ID_REPLACE,SBI_REPLACE,\'frn_value\',\'PB-1\',\'PB-2\',\'PB-3\',\'PB-4\',\'PerR-1\',\'PerR-2\',\'PerR-3\',\'PerR-4\',\'PR-1\',\'PR-2\',\'PR-3\',\'PR-4\',\'1.10\',\'11.10\',\'1.10\',\'11.10\');'
const NUMBER_OF_ITERATIONS = 10

const NUMBER_OF_DC = getRandomBetween(10)
let delinkedCalculationSqlsCount = 1
let totalsSqlsCount = 1
let daxSqlCount = 1

/*
    Insert into organisations first.
    Insert into totals for each sbi ( primary key of organisations, insert random number of times).
    Insert into dax for each calculationId ( primary key of totals, insert random number of times).
    Insert into delinkedCalculation for each sbi (primary key of organisations, insert random number of times)
*/
const filePath = path.join(userHome, 'testData.txt')

createSqls(filePath, () => {
  for (let i = 1; i <= NUMBER_OF_ITERATIONS; i++) {
    const resultString = ORGANISATIONS_INSERT_TEMPLATE_SQL.replace('SBI_REPLACE', i)
    writeSql(filePath, resultString)
    console.log(resultString)
    createSqlForTotals(i)
    createSqlForDelinkedCalculations(i)
  }
})

function createSqlForTotals (sbi) {
  const NUMBER_OF_TOTALS = getRandomBetween(10)
  let calculationId = 0
  for (let i = 1; i <= NUMBER_OF_TOTALS; i++) {
    let resultString = TOTALS_INSERT_TEMPLATE_SQL.replace('SBI_REPLACE', sbi)
    calculationId = totalsSqlsCount++
    resultString = resultString.replace('CALCULATION_ID_REPLACE', calculationId)
    console.log(resultString)
    writeSql(filePath, resultString)
    createSqlForDax(calculationId)
  }
}

function createSqlForDax (calculationId) {
  const NUMBER_OF_DAX = getRandomBetween(5)
  for (let i = 1; i <= NUMBER_OF_DAX; i++) {
    const paymentReference = getRandomPaymentReference() + '_' + daxSqlCount++
    let resultString = DAX_INSERT_TEMPLATE_SQL.replace('CALCULATION_ID_REPLACE', calculationId)
    resultString = resultString.replace('PAYMENT_REFERENCE_REPLACE', paymentReference)
    console.log(resultString)
    writeSql(filePath, resultString)
  }
}

function createSqlForDelinkedCalculations (sbi) {
  for (let i = 1; i <= NUMBER_OF_DC; i++) {
    let resultString = DELINKEDCALSULATION_INSERT_TEMPLATE_SQL.replace('APPLICATION_ID_REPLACE', i)
    resultString = resultString.replace('SBI_REPLACE', sbi)
    resultString = resultString.replace('CALCULATION_ID_REPLACE', delinkedCalculationSqlsCount++)
    console.log(resultString)
    writeSql(filePath, resultString)
  }
}

function getRandomBetween (randomBetween) {
  return Math.floor(Math.random() * randomBetween) + 1
}

function getRandomPaymentReference () {
  const prefix = 'PR-'
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const randomLength = Math.floor(Math.random() * 12) + 1 // Length between 1 and 12
  let randomString = ''

  for (let i = 0; i < randomLength; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length)
    randomString += characters[randomIndex]
  }

  return prefix + randomString
}

function writeSql (filePath, sqlText) {
  sqlText = sqlText + '\n'
  fs.appendFile(filePath, sqlText, 'utf8', (err) => {
    if (err) {
      return console.error('Error writing content to file:', err)
    }
    console.log('File created successfully at', filePath)
  })
}

function createSqls (filePath, callback) {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      return console.error('Error deleting file:', err)
    }
    if (!err) {
      console.log('File deleted successfully at', filePath)
    }
    callback()
  })
}
