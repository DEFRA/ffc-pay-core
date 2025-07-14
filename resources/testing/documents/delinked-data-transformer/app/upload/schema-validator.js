const { logInfo } = require('../util/logger')

/**
 * Gets schema information for tables in the database
 * @param {Object} client PostgreSQL client
 * @returns {Object} Column information by table
 */
async function getSchemaInfo (client) {
  logInfo('Getting schema information for data type validation...')

  const { rows } = await client.query(`
    SELECT 
      table_name,
      column_name, 
      data_type,
      character_maximum_length,
      is_nullable,
      column_default
    FROM 
      information_schema.columns
    WHERE 
      table_schema = 'public'
    ORDER BY 
      table_name, ordinal_position
  `)

  // Organize by table and column for faster lookup
  const schema = {}
  for (const row of rows) {
    if (!schema[row.table_name]) {
      schema[row.table_name] = {}
    }

    schema[row.table_name][row.column_name] = {
      type: row.data_type,
      maxLength: row.character_maximum_length,
      nullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null
    }
  }

  logInfo(`Schema information loaded for ${Object.keys(schema).length} tables`)
  return schema
}

/**
 * Transform a value to match PostgreSQL expected types
 * @param {*} value The value to transform
 * @param {Object} columnInfo Schema information for this column
 * @returns {*} The transformed value
 */
function transformValueForType (value, columnInfo) {
  // Handle NULL values
  if (value === 'NULL' || value === null) {
    if (!columnInfo.nullable && !columnInfo.hasDefault) {
      // Return empty string for non-nullable string columns
      if (columnInfo.type.includes('char')) {
        return "''"
      }
      // Return 0 for non-nullable numeric columns
      if (columnInfo.type.includes('int') || columnInfo.type === 'numeric') {
        return '0'
      }
      // Return current timestamp for non-nullable date/time columns
      if (columnInfo.type.includes('timestamp') || columnInfo.type === 'date') {
        return 'CURRENT_TIMESTAMP'
      }
    }
    return 'NULL'
  }

  // Handle string types
  if (columnInfo.type.includes('char') && columnInfo.maxLength) {
    // Strip quotes if already quoted
    let stringValue = value
    if (stringValue.startsWith("'") && stringValue.endsWith("'")) {
      stringValue = stringValue.substring(1, stringValue.length - 1)
    }

    // Truncate if too long
    if (stringValue.length > columnInfo.maxLength) {
      stringValue = stringValue.substring(0, columnInfo.maxLength)
      // Re-add quotes
      return `'${stringValue.replace(/'/g, "''")}'`
    }
  }

  return value
}

/**
 * Process an SQL statement with schema awareness
 * @param {string} statement SQL statement
 * @param {Object} schema Schema information
 * @returns {string} Modified statement
 */
function validateAndTransformSqlStatement (statement, schema) {
  // Only process INSERT statements
  if (!statement.toUpperCase().startsWith('INSERT INTO')) {
    return statement
  }

  try {
    // Extract table name from INSERT statement
    const tableMatch = statement.match(/INSERT INTO (?:public\.)?["']?([^"'\s(]+)/i)
    if (!tableMatch) return statement

    const tableName = tableMatch[1]
    if (!schema[tableName]) {
      return statement // No schema info for this table
    }

    // Parse columns and values
    const columnsMatch = statement.match(/\(([^)]+)\) VALUES/i)
    if (!columnsMatch) return statement

    const columns = columnsMatch[1].split(',').map(col =>
      col.trim().replace(/^["']|["']$/g, '') // Strip quotes from column names
    )

    // Find the VALUES part and fix any data type issues
    return statement.replace(/VALUES\s+(\([^;]+\));?/i, (match, valuesGroup) => {
      // Process each VALUES tuple
      const processedValues = valuesGroup
        .replace(/\),\s*\(/g, '),|(') // Mark tuple boundaries
        .split('|')
        .map(tuple => {
          // Remove opening/closing parens
          const values = tuple.replace(/^\s*\(\s*|\s*\)\s*$/g, '').split(',')

          // Process each value according to its column's type
          const processedValues = values.map((value, i) => {
            if (i >= columns.length) return value.trim()

            const colName = columns[i]
            const colInfo = schema[tableName][colName]
            if (!colInfo) return value.trim()

            return transformValueForType(value.trim(), colInfo)
          })

          return `(${processedValues.join(', ')})`
        }).join(',\n')

      return `VALUES ${processedValues};`
    })
  } catch (error) {
    // If any error in processing, return the original statement
    return statement
  }
}

module.exports = {
  getSchemaInfo,
  validateAndTransformSqlStatement
}
