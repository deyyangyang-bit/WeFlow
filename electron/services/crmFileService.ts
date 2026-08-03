/**
 * crmFileService.ts
 * 微信文件缓存定位与归档（Mac 优先；Windows 二期）。
 * 路径模式来自真实样本：~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/*/temp/RWTemp/**
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

class CrmFileService {
  private scanRoots(): string[] {
    const base = join(homedir(), 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
    if (!existsSync(base)) return []
    const roots: string[] = []
    for (const wxid of readdirSync(base)) {
      const rw = join(base, wxid, 'temp', 'RWTemp')
      if (existsSync(rw)) roots.push(rw)
      const file = join(base, wxid, 'msg', 'file')
      if (existsSync(file)) roots.push(file)
    }
    return roots
  }

  private walk(dir: string, depth: number, out: string[]): void {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) this.walk(full, depth + 1, out)
      else out.push(full)
    }
  }

  findFile(fileName: string, md5?: string): string | null {
    if (!fileName) return null
    for (const root of this.scanRoots()) {
      const files: string[] = []
      this.walk(root, 0, files)
      for (const f of files) {
        if (!f.endsWith('/' + fileName) && !f.endsWith(fileName)) continue
        if (md5) {
          try {
            const h = createHash('md5').update(readFileSync(f)).digest('hex')
            if (h.toLowerCase() !== md5.toLowerCase()) continue
          } catch { continue }
        }
        return f
      }
    }
    return null
  }

  /** 找到则拷贝到 userData/crm-files/ 并返回归档路径；找不到返回 null（待归档） */
  archive(fileName: string, userDataPath: string, md5?: string): string | null {
    const src = this.findFile(fileName, md5)
    if (!src) return null
    const destDir = join(userDataPath, 'crm-files')
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, `${Date.now()}_${fileName}`)
    try { copyFileSync(src, dest) } catch { return null }
    return dest
  }
}

export const crmFileService = new CrmFileService()
