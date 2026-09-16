import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultDistDir = resolve(scriptPath, '..', 'dist')

function moduleUrl(distDir, relativePath) {
  return pathToFileURL(resolve(distDir, relativePath)).href
}

/**
 * Load the emitted Central modules through Node's real ESM loader.
 * This intentionally does not start the HTTP server, connect to PostgreSQL, or read config.
 */
export async function verifyCentralDist(distDir = defaultDistDir) {
  const app = await import(moduleUrl(distDir, 'central/src/app.js'))
  if (typeof app.buildCentralApp !== 'function') {
    throw new Error('central dist app.js is missing the buildCentralApp function export')
  }

  const sync = await import(moduleUrl(distDir, 'shared/centralSync.js'))
  if (!Array.isArray(sync.CENTRAL_ENTITY_TYPES) || sync.CENTRAL_ENTITY_TYPES.length === 0) {
    throw new Error('central dist centralSync.js is missing CENTRAL_ENTITY_TYPES')
  }

  const down = await import(moduleUrl(distDir, 'shared/centralDownCommand.js'))
  if (typeof down.validateDownCommand !== 'function') {
    throw new Error('central dist centralDownCommand.js is missing validateDownCommand')
  }

  console.log('central dist import ok')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === scriptPath
if (isMain) {
  try {
    await verifyCentralDist()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`central dist runtime import failed: ${message}`)
    process.exitCode = 1
  }
}
