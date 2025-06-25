/**
 * Centralized logging module
 */

/**
 * Log informational message
 * @param {string} message - Message to log
 * @param {string} level - Log level (info, warn, error)
 */
function logInfo (message, level = 'info') {
  const prefix = level === 'error'
    ? '❌'
    : level === 'warn'
      ? '⚠️'
      : '   '
  console.log(`${prefix} ${message}`)
}

/**
 * Log error message
 * @param {string} message - Error message
 */
function logError (message) {
  console.error(`❌ ${message}`)
}

/**
 * Log progress indicator without newline
 * @param {string} char - Character to display
 */
function logProgress (char = '.') {
  process.stdout.write(char)
}

/**
 * Logs execution summary
 * @param {Object} stats - Execution statistics
 */
function logExecutionSummary (stats) {
  console.log('\nExecution summary:')
  console.log(`  - Executed statements: ${stats.executed}`)
  console.log('  - Statement types:')
  Object.entries(stats.statementTypes).forEach(([type, count]) => {
    if (count > 0) {
      console.log(`    * ${type}: ${count}`)
    }
  })
  console.log(`  - Skipped statements: ${stats.skipped.total}`)
  if (stats.skipped.total > 0) {
    console.log(`    * Meta commands: ${stats.skipped.metaCommands}`)
    console.log(`    * Constraints: ${stats.skipped.constraints}`)
    console.log(`    * Already exists: ${stats.skipped.alreadyExists}`)
    console.log(`    * Other errors: ${stats.skipped.otherErrors}`)
  }
}

module.exports = {
  logInfo,
  logError,
  logProgress,
  logExecutionSummary
}
