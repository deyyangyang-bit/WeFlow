import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { existsSync, readdirSync, rmSync } from 'fs'
import { dirname, resolve, sep } from 'path'

// ⛔ 环境变量坑：ELECTRON_RUN_AS_NODE=1 会让 Electron 以 Node 模式启动（GUI 不出现，
//   --version 输出内嵌 Node 版本 v24.17.0 而非 Electron 43.0.0）。
//   某些 shell/工具会话会注入该变量。vite 是 spawn Electron 的父进程，必须在 spawn 前清除。
//   （Linux 侧同款处理见 electron/services/keyServiceLinux.ts）
delete process.env.ELECTRON_RUN_AS_NODE

// vite dev 护栏（2026-09-06 三次实证）：vite-plugin-electron 在 Electron 子进程已退出后，
// 仍会对重建完成的 entry 调 onstart→reload()，child_process.send 对已关闭通道除同步抛错外，
// 还会**异步**在 child 上 emit 'error'（无监听器 → 进程级 uncaughtException，try/catch 拦不住）。
// 这里只精确吞掉 ERR_IPC_CHANNEL_CLOSED 这一类（子进程不在 = 没有可刷新对象），
// 其余异常保持原样终止，不掩盖真实错误。
process.on('uncaughtException', (err) => {
  if ((err as NodeJS.ErrnoException)?.code === 'ERR_IPC_CHANNEL_CLOSED') {
    console.warn('[vite] Electron 子进程已退出，跳过 reload（ERR_IPC_CHANNEL_CLOSED）——下次 npm run dev 自然重启应用')
    return
  }
  console.error(err)
  process.exit(1)
})

const handleElectronOnStart = (options: { reload: () => void }) => {
  try {
    options.reload()
  } catch { /* 同步抛错路径；异步 'error' 事件由上方 uncaughtException 护栏兜住 */ }
}

/** electron 目录下的同名 .js 是可再生 tsc 中间产物；扩展名省略时始终以 TS 源码为准。 */
function preferElectronTypeScriptPlugin() {
  const electronRoot = resolve(__dirname, 'electron')
  return {
    name: 'weflow-prefer-electron-typescript',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith('.') || /\.[A-Za-z0-9]+$/.test(source)) return null
      const candidate = resolve(dirname(importer.split('?')[0]), source)
      if (candidate !== electronRoot && !candidate.startsWith(`${electronRoot}${sep}`)) return null
      for (const ext of ['.ts', '.tsx']) {
        const typed = `${candidate}${ext}`
        if (existsSync(typed)) return typed
      }
      return null
    }
  }
}

/** 移除 tsc 原位生成的可再生文件，防止 Electron 子构建把旧 .js 当成源码。 */
function removeGeneratedTypeScriptSiblings(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      removeGeneratedTypeScriptSiblings(path)
      continue
    }
    const match = entry.name.match(/^(.*)\.(?:ts|tsx)$/)
    if (!match || entry.name.endsWith('.d.ts')) continue
    const target = resolve(root, `${match[1]}.js`)
    if (existsSync(target)) rmSync(target)
  }
}

removeGeneratedTypeScriptSiblings(resolve(__dirname, 'electron'))
removeGeneratedTypeScriptSiblings(resolve(__dirname, 'shared'))

const exportWorkerElectronShimPlugin = () => {
  const virtualId = 'virtual:weflow-export-worker-electron'
  const resolvedVirtualId = `\0${virtualId}`

  return {
    name: 'weflow-export-worker-electron-shim',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === virtualId) return resolvedVirtualId
      return null
    },
    load(id: string) {
      if (id !== resolvedVirtualId) return null
      return `
        import { homedir, tmpdir } from 'os'
        import { join } from 'path'

        const workerUserDataPath = () => String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
        const appDataPath = () => {
          if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA
          if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
          return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
        }
        const getPath = (name) => {
          if (name === 'userData') return workerUserDataPath() || join(appDataPath(), 'WeFlow')
          if (name === 'documents') return join(homedir(), 'Documents')
          if (name === 'desktop') return join(homedir(), 'Desktop')
          if (name === 'downloads') return join(homedir(), 'Downloads')
          if (name === 'temp') return tmpdir()
          if (name === 'appData') return appDataPath()
          return process.cwd()
        }

        export const app = {
          isPackaged: Boolean(process.resourcesPath && process.env.NODE_ENV !== 'development'),
          getPath,
          getAppPath: () => process.cwd(),
          getName: () => 'WeFlow',
          getVersion: () => process.env.npm_package_version || '0.0.0',
          // Worker 中不存在 app 生命周期事件（如 will-quit），no-op 兼容注册退出钩子的服务
          on: () => app,
          once: () => app,
          off: () => app,
          removeListener: () => app,
          removeAllListeners: () => app
        }
        export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null }
        export const dialog = { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) }
        export const shell = { openExternal: async () => false, showItemInFolder: () => {} }
        export const ipcMain = { on: () => {}, handle: () => {}, removeHandler: () => {} }
        export const ipcRenderer = { sendSync: () => ({}) }
        export const safeStorage = {
          isEncryptionAvailable: () => false,
          encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
          decryptString: (value) => Buffer.isBuffer(value) ? value.toString('utf8') : Buffer.from(value).toString('utf8')
        }
        export const Notification = class {
          static isSupported() { return false }
          on() { return this }
          show() {}
          close() {}
        }
        export default { app, BrowserWindow, dialog, shell, ipcMain, ipcRenderer, safeStorage, Notification }
      `
    },
    transform(code: string, id: string) {
      if (!/\.[cm]?[jt]s$/.test(id)) return null
      if (!code.includes("'electron'") && !code.includes('"electron"')) return null
      const next = code
        .replace(/from\s+(['"])electron\1/g, `from '${virtualId}'`)
        .replace(/import\s*\(\s*(['"])electron\1\s*\)/g, `import('${virtualId}')`)
        .replace(/require\s*\(\s*(['"])electron\1\s*\)/g, `require('${virtualId}')`)
      return next === code ? null : { code: next, map: null }
    }
  }
}

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    strictPort: false  // 如果3000被占用，自动尝试下一个
  },
  build: {
    chunkSizeWarningLimit: 900,
    commonjsOptions: {
      ignoreDynamicRequires: true
    }
  },
  optimizeDeps: {
    exclude: []
  },
  plugins: [
    preferElectronTypeScriptPlugin(),
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'whisper-node',
                'shelljs',
                'exceljs',
                'node-llama-cpp',
                '@vscode/sudo-prompt',
                'silk-wasm',
                // 原生 .node 二进制不可打包，运行时从 asarUnpack 目录解析
                '@hicccc77/electron-liquid-glass'
              ]
            }
          }
        }
      },
      {
        entry: 'electron/annualReviewWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'annualReviewWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/imageSearchWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'imageSearchWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/imageDecryptWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'imageDecryptWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/wcdbWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'wcdbWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/transcribeWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'sherpa-onnx-node'
              ],
              output: {
                entryFileNames: 'transcribeWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/exportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          plugins: [exportWorkerElectronShimPlugin()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'exceljs'
              ],
              output: {
                entryFileNames: 'exportWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/apiMessageWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'apiMessageWorker.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        // Hermes UtilityProcess 入口（Agent Loop 宿主；main.ts 经 utilityProcess.fork 加载）
        entry: 'electron/hermes/hermesUtilityEntry.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'hermesUtility.js',
                codeSplitting: false
              }
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      }
    ])
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})
