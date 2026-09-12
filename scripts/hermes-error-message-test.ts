/** Hermes Main/Renderer 共用人话错误映射的纯函数测试。 */
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { getHermesErrorMessage, HERMES_ERROR_MESSAGES } from '../shared/hermesErrorMessages'

let pass = 0
let fail = 0
function ok(condition: boolean, label: string): void {
  if (condition) { pass++; return }
  fail++
  throw new Error(`断言失败: ${label}`)
}

const expected: Record<string, string> = {
  agent_starting: 'Hermes 正在启动，请稍后再试。',
  agent_unavailable: 'Hermes 暂时不可用，请重启应用后再试。',
  agent_missing: 'Hermes 暂时不可用，请重新安装或升级应用。',
  protocol_mismatch: 'Hermes 组件版本不一致，请重新安装或升级应用。',
  timeout: '本次分析超时，请稍后重试。',
  not_configured: '还没有配置 AI 模型：请到 设置 → AI 设置 完成配置后再试。'
}

for (const [code, message] of Object.entries(expected)) {
  ok(HERMES_ERROR_MESSAGES[code] === message, `${code} 映射逐字一致`)
  ok(getHermesErrorMessage(code) === message, `${code} 纯函数返回逐字一致`)
}
ok(getHermesErrorMessage('unknown') === '暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。', '未知码保留通用人话')

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const panel = readFileSync(join(root, 'src/components/hermes/HermesPanel.tsx'), 'utf8')
ok(panel.includes('getHermesErrorMessage(r.errorCode)'), '开始失败使用共享映射')
ok(panel.includes('setContinueError(getHermesErrorMessage(r.errorCode))'), '追问失败使用共享映射')
ok(panel.includes("setContinueError(getHermesErrorMessage('internal'))"), '追问异常也显示人话')

console.log(`${fail === 0 ? '🎉 全部通过' : '⚠️ 存在失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
