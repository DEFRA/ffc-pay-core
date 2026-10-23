const DEFAULT_MAX_PARAMS = 5000

function calculateBatchSize (paramCountPerItem, maxParams = DEFAULT_MAX_PARAMS) {
  if (paramCountPerItem <= 0) {
    throw new Error('paramCountPerItem must be greater than 0')
  }
  if (maxParams <= 0) {
    throw new Error('maxParams must be greater than 0')
  }

  return Math.max(1, Math.floor(maxParams / paramCountPerItem))
}

function assertWithinLimit (itemCount, paramCountPerItem, label = 'query', maxParams = DEFAULT_MAX_PARAMS) {
  const totalParams = itemCount * paramCountPerItem
  if (totalParams > maxParams) {
    throw new Error(`${label} requires ${totalParams} parameters, exceeding limit of ${maxParams} (${itemCount} items × ${paramCountPerItem} params)`)
  }
}

function buildInPlaceholders (count, startParam = 1) {
  const placeholders = []
  for (let i = 0; i < count; i++) {
    placeholders.push(`$${startParam + i}`)
  }
  return placeholders.join(', ')
}

function buildTuplePlaceholders (tupleCount, tupleSize, startParam = 1) {
  let paramIndex = startParam
  const tuples = []
  for (let i = 0; i < tupleCount; i++) {
    const tuple = []
    for (let j = 0; j < tupleSize; j++) {
      tuple.push(`$${paramIndex++}`)
    }
    tuples.push(`(${tuple.join(', ')})`)
  }
  return { placeholders: tuples.join(', '), nextParam: paramIndex }
}

async function runBatched (items, paramCountPerItem, maxParams, operation) {
  if (items.length === 0) {
    return []
  }

  if (paramCountPerItem > maxParams) {
    throw new Error(`A single item requires ${paramCountPerItem} parameters, exceeding limit of ${maxParams}`)
  }

  const batchSize = calculateBatchSize(paramCountPerItem, maxParams)
  const results = []

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    assertWithinLimit(batch.length, paramCountPerItem, 'single batch', maxParams)
    const batchResults = await operation(batch, i)
    if (batchResults && batchResults.length > 0) {
      results.push(...batchResults)
    }
  }

  return results
}

module.exports = {
  calculateBatchSize,
  assertWithinLimit,
  buildInPlaceholders,
  buildTuplePlaceholders,
  runBatched
}
