const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const mainPath = join(__dirname, '..', 'dist-electron', 'main.js')
if (!existsSync(mainPath)) throw new Error('dist-electron/main.js 不存在')

const bundle = readFileSync(mainPath, 'utf8')
if (bundle.includes('kbSearchPublished')) {
  throw new Error('Electron 产物混入旧知识库实现 kbSearchPublished')
}
for (const marker of ['knowledge_usage', 'kbValidEntries', 'sales:kb:renewTtl']) {
  if (!bundle.includes(marker)) throw new Error(`Electron 产物缺少知识治理标记: ${marker}`)
}

console.log('[verify] Electron bundle uses current TypeScript knowledge governance')
