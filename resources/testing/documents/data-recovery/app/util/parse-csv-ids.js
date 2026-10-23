const fs = require('fs')

function parseCsvIds (filePath) {
  if (!fs.existsSync(filePath)) {
    return []
  }

  const rawText = fs.readFileSync(filePath, 'utf8')
  const matches = rawText.match(/\d+/g) || []
  return [...new Set(matches.map(Number))]
}

module.exports = {
  parseCsvIds
}
