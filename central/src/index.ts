import { buildCentralApp } from './app.js'
import { loadCentralConfig } from './config.js'
import { PostgresCentralStore } from './postgresStore.js'

const config = loadCentralConfig()
const store = new PostgresCentralStore(config.databaseUrl)
await store.migrate()
const app = buildCentralApp({ store, config, logger: true })

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  await app.close()
  process.exit(1)
}
