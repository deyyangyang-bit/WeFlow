/**
 * ai-provider-compat-test.ts —— OpenAI 兼容服务商的思考参数兼容性。
 *
 * GLM-5.3-Flash 对 DeepSeek 风格 enable_thinking=false 返回 400/1210；
 * 关闭思考不是正确性前提，因此 GLM 请求必须省略该扩展字段。
 */
import { buildDisableThinkingPayload } from '../electron/services/ai/aiApiClient'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`✓ ${label}`)
  } else {
    failed++
    console.error(`✗ ${label}`)
  }
}

const glmByModel = buildDisableThinkingPayload({
  apiBaseUrl: 'https://example-proxy.internal/v1',
  apiKey: 'test-only',
  model: 'glm-5.3-flash',
  maxTokens: 1024
})
check('GLM 模型经代理时省略 enable_thinking', !('enable_thinking' in glmByModel))

const glmByHost = buildDisableThinkingPayload({
  apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'test-only',
  model: 'custom-model-name',
  maxTokens: 1024
})
check('智谱官方域名使用自定义模型名时仍省略 enable_thinking', !('enable_thinking' in glmByHost))

const deepseek = buildDisableThinkingPayload({
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'test-only',
  model: 'deepseek-chat',
  maxTokens: 1024
})
check('DeepSeek 保留 enable_thinking=false', deepseek.enable_thinking === false)

const generic = buildDisableThinkingPayload({
  apiBaseUrl: 'https://openai-compatible.example/v1',
  apiKey: 'test-only',
  model: 'generic-chat',
  maxTokens: 1024
})
check('其他兼容端点保持既有参数行为', generic.enable_thinking === false)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
