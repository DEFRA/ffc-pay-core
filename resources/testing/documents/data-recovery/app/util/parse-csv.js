const fs = require('fs')

function parseCsv (filePath) {
  if (!fs.existsSync(filePath)) {
    return []
  }

  const rawText = fs.readFileSync(filePath, 'utf8')
  const lines = rawText.split(/\r?\n/).filter(line => line.trim().length > 0)

  if (lines.length === 0) {
    return []
  }

  const headers = lines[0].split(',').map(h => h.trim())
  const headerIndex = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase())

  const frnIndex = headerIndex('frn')
  const schemeIndex = headerIndex('scheme')
  const agreementNumberIndex = headerIndex('agreementNumber')

  if (frnIndex === -1 || schemeIndex === -1 || agreementNumberIndex === -1) {
    throw new Error(`CSV must contain frn, scheme and agreementNumber columns. Found: ${headers.join(', ')}`)
  }

  return lines.slice(1).map(line => {
    const values = line.split(',')
    return {
      frn: values[frnIndex]?.trim() ?? null,
      schemeId: values[schemeIndex]?.trim() ?? null,
      agreementNumber: values[agreementNumberIndex]?.trim() ?? null
    }
  }).filter(row => row.frn && row.schemeId && row.agreementNumber)
}

module.exports = {
  parseCsv
}
