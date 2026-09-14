/**
 * typecheck-node-ratchet.cjs —— 主进程（electron/）类型门禁 · 棘轮策略
 *
 * 背景：根 tsconfig.json 只 include src/** + shared/**，`npx tsc --noEmit` 不覆盖 electron/。
 * 主进程走 tsconfig.node.json（references 被引用工程，不带 -p 的 --noEmit 不会连带检查），
 * 导致 electron/ 类型错误长期无人拦截（2026-09-13 实测存量 156 个，见
 * docs/实施记录/AI简报与按需识别-实施记录-claude-20260912.md §0）。
 *
 * 棘轮口径：**只准降、不准涨**——错误数 > BASELINE 即失败；消肿后把 BASELINE 下调收紧。
 * 修复存量请按类进行，禁止用 as any / @ts-ignore 糊墙冲数。
 */
const { execFileSync } = require('child_process')

// 基线史：156（2026-09-13 实测，历史 161 → 156）→ 8（2026-09-14 存量类型消肿）
//   → 7（同日：MigrationReportSummary interface→type，消掉迁移报告摘要的索引签名错误）
//   → 3（同日：crmDbService ×2 / crmIpcHandlers ×2 修完后的实测值，见下方订正）
//   → 0（同日：crmIpcHandlers 首次分类 reject 补 Promise.resolve、export facade 删死委托、
//          messagePushService 会话类型分类改按 sessionId 形态）。
// ⚠️ 订正：实施记录 §2「剩余 7 个」的枚举漏了 messagePushService:1171/1174 的 2 个 TS2367
//   （`session.type` 数值与 'official'/'friend' 字符串比较，`error TS2367`）；该文件编辑前实测仍报，
//   故编辑前真实为 3 个而非 1 个。基线已同步收紧到 0，之后只准保持 0。
const BASELINE = 0

let out = ''
try {
  out = execFileSync('npx', ['tsc', '-p', 'tsconfig.node.json', '--noEmit', '--composite', 'false'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024
  })
} catch (e) {
  // tsc 有错误时 exit!=0，输出在 stdout
  out = (e.stdout || '') + (e.stderr || '')
}

const count = (out.match(/error TS/g) || []).length
if (count > BASELINE) {
  console.error(`❌ electron/ 类型错误 ${count} 个，超过棘轮基线 ${BASELINE}（只准降不准涨）`)
  console.error('   排查：npx tsc -p tsconfig.node.json --noEmit --composite false')
  process.exit(1)
}
console.log(`✅ electron/ 类型错误 ${count} 个（棘轮基线 ${BASELINE}）${count < BASELINE ? '，建议把基线收紧到 ' + count : ''}`)
