const { Sequelize, DataTypes } = require('sequelize')

const args = process.argv.slice(2)
console.log('Command line arguments:', args)

const recordCount = parseInt(args[0]) || 250000
console.log('Parsed record count:', recordCount)

if (isNaN(recordCount) || recordCount <= 0) {
  console.error('Please provide a valid positive number')
  process.exit(1)
}

const getTimestamps = (type) => {
  const now = new Date()
  const base = {
    updated: now
  }

  switch (type) {
    case 'organisation':
      return base
    case 'delinkedCalculation':
      return {
        ...base,
        datePublished: new Date(now.getTime() - 60000)
      }
    case 'd365':
      return {
        ...base,
        datePublished: new Date(now.getTime() - 60000)
      }
    default:
      return base
  }
}

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
    connectTimeout: 60000,
    ssl: {
      require: true,
      rejectUnauthorised: false
    }
  }
}

const sequelize = new Sequelize(dbConfig)

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
  console.log(`Starting data generation for ${recordCount} records`)

  try {
    for (let offset = 0; offset < recordCount; offset += batchSize) {
      const limit = Math.min(batchSize, recordCount - offset)
      console.log(`Processing batch: ${offset} to ${offset + limit}`)

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
        const emailAddress = 'documents.performance.test@gmail.com'
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
          ...getTimestamps('organisation')
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
          ...getTimestamps('delinkedCalculation')
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
