const fs = require('node:fs/promises')
const path = require('node:path')

function defaultCheckpointPath (serviceName, options = {}) {
  const outputDir = options.outputDir || path.resolve(__dirname, '../../checkpoints')
  const sourceEnvironment = options.sourceEnvironment || 'prd'
  const targetEnvironment = options.targetEnvironment || 'pre'
  const safeServiceName = String(serviceName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(outputDir, `${safeServiceName}-${sourceEnvironment}-to-${targetEnvironment}.json`)
}

async function ensureDirectoryExists (dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function saveCheckpoint (serviceName, data, options = {}) {
  const sourceEnvironment = options.sourceEnvironment || 'prd'
  const targetEnvironment = options.targetEnvironment || 'pre'
  const outputDir = options.outputDir || path.resolve(__dirname, '../../checkpoints')
  const filePath = defaultCheckpointPath(serviceName, { outputDir, sourceEnvironment, targetEnvironment })

  await ensureDirectoryExists(outputDir)

  const payload = {
    serviceName,
    sourceEnvironment,
    targetEnvironment,
    sourceDbName: data.sourceDbName,
    targetDbName: data.targetDbName,
    updatedAt: new Date().toISOString(),
    status: data.status || 'in-progress',
    tables: data.tables || []
  }

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')

  return { saved: true, filePath }
}

async function loadCheckpoint (serviceName, options = {}) {
  const sourceEnvironment = options.sourceEnvironment || 'prd'
  const targetEnvironment = options.targetEnvironment || 'pre'
  const outputDir = options.outputDir || path.resolve(__dirname, '../../checkpoints')
  const filePath = defaultCheckpointPath(serviceName, { outputDir, sourceEnvironment, targetEnvironment })

  try {
    const content = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(content)
    return {
      filePath,
      exists: true,
      ...parsed
    }
  } catch (error) {
    return {
      filePath,
      exists: false,
      status: 'missing',
      tables: []
    }
  }
}

async function resetCheckpoint (serviceName, options = {}) {
  const checkpoint = await loadCheckpoint(serviceName, options)
  if (!checkpoint.exists) {
    return { reset: false, filePath: checkpoint.filePath }
  }
  await fs.unlink(checkpoint.filePath)
  return { reset: true, filePath: checkpoint.filePath }
}

module.exports = {
  defaultCheckpointPath,
  saveCheckpoint,
  loadCheckpoint,
  resetCheckpoint,
  ensureDirectoryExists
}
