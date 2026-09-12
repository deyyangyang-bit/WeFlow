/**
 * autoBackupSecretBox.ts —— Electron safeStorage → SecretBox 适配（仅 main 进程）。
 * Windows=DPAPI / macOS=钥匙串；本模块只做适配，密钥文件格式与迁移逻辑在
 * autoBackupKeyVault.ts（零 Electron，可 tsx 单测）。系统安全设施不可用时返回 null，
 * 由装配层回退 local-wrap 并在状态中如实展示降级。
 */
import { safeStorage } from 'electron'
import { MASTER_KEY_LENGTH, type SecretBox } from './autoBackupKeyVault'

export function electronSecretBox(): SecretBox | null {
  try {
    if (!safeStorage?.isEncryptionAvailable?.()) return null
  } catch {
    return null
  }
  return {
    name: 'electron-safeStorage',
    // safeStorage 只承诺字符串保真：主密钥以 base64 过桥，避免二进制经 UTF-8 往返失真
    encrypt(plaintext) {
      return safeStorage.encryptString(plaintext.toString('base64'))
    },
    decrypt(blob) {
      const decoded = Buffer.from(safeStorage.decryptString(blob), 'base64')
      if (decoded.length !== MASTER_KEY_LENGTH) throw new Error(`解封后的密钥长度非法（${decoded.length}）`)
      return decoded
    }
  }
}
