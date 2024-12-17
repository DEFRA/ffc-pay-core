const { Sequelize, DataTypes } = require('sequelize')

const dbConfig = {
  database: 'ffc_doc_statement_data',
  dialect: 'postgres',
  host: 'localhost',
  password: 'ppp',
  port: 5482,
  logging: false,
  schema: 'public',
  username: 'postgres',
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  retry: {
    max: 5
  },
  dialectOptions: {
    connectTimeout: 60000
  }
}

const sequelize = new Sequelize(dbConfig)

// Initialize models
const Organisation = sequelize.define('organisation', {
  sbi: { type: DataTypes.INTEGER, primaryKey: true },
  addressLine1: DataTypes.STRING,
  addressLine2: DataTypes.STRING,
  addressLine3: DataTypes.STRING,
  city: DataTypes.STRING,
  county: DataTypes.STRING,
  postcode: DataTypes.STRING,
  emailAddress: DataTypes.STRING,
  frn: DataTypes.BIGINT,
  name: DataTypes.STRING,
  updated: DataTypes.DATE
}, {
  tableName: 'organisations',
  freezeTableName: true,
  timestamps: false
})

const DelinkedCalculation = sequelize.define('delinkedCalculation', {
  applicationId: { type: DataTypes.INTEGER, allowNull: false },
  calculationId: { type: DataTypes.INTEGER, primaryKey: true },
  sbi: DataTypes.INTEGER,
  frn: DataTypes.STRING,
  paymentBand1: DataTypes.STRING,
  paymentBand2: DataTypes.STRING,
  paymentBand3: DataTypes.STRING,
  paymentBand4: DataTypes.STRING,
  percentageReduction1: DataTypes.STRING,
  percentageReduction2: DataTypes.STRING,
  percentageReduction3: DataTypes.STRING,
  percentageReduction4: DataTypes.STRING,
  progressiveReductions1: DataTypes.STRING,
  progressiveReductions2: DataTypes.STRING,
  progressiveReductions3: DataTypes.STRING,
  progressiveReductions4: DataTypes.STRING,
  referenceAmount: DataTypes.STRING,
  totalProgressiveReduction: DataTypes.STRING,
  totalDelinkedPayment: DataTypes.STRING,
  paymentAmountCalculated: DataTypes.STRING,
  datePublished: DataTypes.DATE,
  updated: DataTypes.DATE
}, {
  tableName: 'delinkedCalculation',
  freezeTableName: true,
  timestamps: false
})

const D365 = sequelize.define('d365', {
  paymentReference: { type: DataTypes.STRING, primaryKey: true },
  calculationId: DataTypes.INTEGER,
  paymentPeriod: DataTypes.STRING,
  paymentAmount: DataTypes.DECIMAL,
  transactionDate: DataTypes.DATE,
  datePublished: DataTypes.DATE
}, {
  tableName: 'd365',
  freezeTableName: true,
  timestamps: false
})

async function generateData () {
  const batchSize = 10000
  const totalRecords = 250000

  try {
    for (let offset = 0; offset < totalRecords; offset += batchSize) {
      const limit = Math.min(batchSize, totalRecords - offset)
      console.log(`Processing batch ${offset + 1} to ${offset + limit}`)

      const organisations = []
      const delinkedCalculations = []
      const d365Entries = []

      for (let i = 1; i <= limit; i++) {
        const index = offset + i
        const sbi = 123000000 + index
        const frn = (1234000000 + index).toString()
        const calculationId = 987000000 + index
        const paymentReference = `PY${String(index).padStart(7, '0')}`
        const name = `Performance farm${index}`
        const emailAddress = `performanceTest${index}@defrafcp.com`
        const applicationId = 1234567 + index

        organisations.push({
          sbi,
          addressLine1: 'Street',
          addressLine2: 'Area',
          addressLine3: 'District',
          city: 'City',
          county: 'County',
          postcode: 'AA1 1BB',
          emailAddress,
          frn,
          name,
          updated: new Date()
        })

        delinkedCalculations.push({
          applicationId,
          calculationId,
          sbi,
          frn,
          paymentBand1: '30000',
          paymentBand2: '50000',
          paymentBand3: '150000',
          paymentBand4: '99999999.99',
          percentageReduction1: '50',
          percentageReduction2: '55',
          percentageReduction3: '65',
          percentageReduction4: '70',
          progressiveReductions1: '15000',
          progressiveReductions2: '11000',
          progressiveReductions3: '65000',
          progressiveReductions4: '35000',
          totalProgressiveReduction: '126000',
          referenceAmount: '2000000',
          totalDelinkedPayment: '75000',
          paymentAmountCalculated: '37500',
          datePublished: new Date(),
          updated: new Date()
        })

        d365Entries.push({
          calculationId,
          paymentPeriod: '2024',
          paymentReference,
          paymentAmount: 37500,
          transactionDate: new Date()
        })
      }

      await Organisation.bulkCreate(organisations, { validate: false })
      await DelinkedCalculation.bulkCreate(delinkedCalculations, { validate: false })
      await D365.bulkCreate(d365Entries, { validate: false })

      console.log(`Completed batch ${offset + 1} to ${offset + limit}`)
    }
  } catch (error) {
    console.error('Error generating data:', error)
    throw error
  }
}

// Run the data generation
generateData()
  .then(() => {
    console.log('Data generation completed successfully')
    process.exit(0)
  })
  .catch(err => {
    console.error('Failed to generate data:', err)
    process.exit(1)
  })
