// 构建前清空 dist-electron：vite 产物带内容 hash（如 config-XXXX.js），
// 不清理会让旧版本 chunk 无限堆积并被误打进安装包
const { rmSync, existsSync, readdirSync } = require('fs')
const { join } = require('path')

const dir = join(__dirname, '..', 'dist-electron')
if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true })
  console.log('[clean] dist-electron removed')
}

// tsconfig.node 旧配置会在源码旁生成 .js，Electron 构建会优先读到这些旧文件。
// 只删除“同目录存在同名 .ts/.tsx”的可再生 .js，不触碰项目引用需要的 .d.ts 和 wasm 资源。
function removeGeneratedSiblings(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      removeGeneratedSiblings(path)
      continue
    }
    const match = entry.name.match(/^(.*)\.(?:ts|tsx)$/)
    if (!match || entry.name.endsWith('.d.ts')) continue
    const target = join(root, `${match[1]}.js`)
    if (existsSync(target)) rmSync(target)
  }
}

removeGeneratedSiblings(join(__dirname, '..', 'electron'))
removeGeneratedSiblings(join(__dirname, '..', 'shared'))
for (const generated of ['vite.config.js']) {
  const target = join(__dirname, '..', generated)
  if (existsSync(target)) rmSync(target)
}
