const convert = require('./convert')
const { DAX, D365, ORGANISATION, DELINKED, CALCULATION, TOTAL } = require('./constants/types')

const processConversion = async () => {
  try {
    console.log('Converting inbound data...')
    await convert(DAX)
    await convert(D365)
    await convert(ORGANISATION)
    await convert(DELINKED)
    await convert(CALCULATION)
    await convert(TOTAL)
    console.log('Inbound data converted successfully')
  } catch (error) {
    console.error('Failed to convert inbound data', error)
  }
}
module.exports = processConversion
