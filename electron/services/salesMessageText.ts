/**
 * salesMessageText.ts —— 销售 AI 链路共用的「会话消息 → prompt 上下文」工具。
 *
 * 三条链路（意向分级 salesIntentService / 承诺核验 salesFollowUpService /
 * 回复建议 salesReplyService）此前各自复制了同一套 extractContent / getIsSend /
 * formatMessages。此处收敛为唯一实现，勿再各自复制。
 *
 * 三处唯一真实差异是「单行截断长度」与「上下文总长上限」，故作为入参保留，
 * 调用方按各自链路预算传入（150/1500、200/2000）。
 */

/** 从消息对象提取可读纯文本；XML/系统消息返回空串，调用方据此跳过该条 */
export function extractContent(msg: any): string {
  // 兼容 parsedContent（chatService 格式）和 message_content（WCDB 原始格式）
  const raw = String(msg.parsedContent || msg.rawContent || msg.message_content || msg.content || '').trim()
  if (!raw) return ''
  // 跳过 XML/系统消息
  if (/^(<\?xml|<msg\b|<appmsg\b|<img\b|<emoji\b|<voip\b|<sysmsg\b)/i.test(raw)) return ''
  // 尝试从 XML 中提取纯文本
  const textMatch = raw.match(/<content[^>]*>([^<]+)<\/content>/i)
  if (textMatch) return textMatch[1].trim()
  if (raw.startsWith('<')) return ''
  return raw
}

/** 发送方向：1 = 我方发出，0 = 对方（字段名多版本兼容，缺失按 0） */
export function getIsSend(msg: any): number {
  if (msg.isSend !== undefined && msg.isSend !== null) return Number(msg.isSend)
  if (msg.computed_is_send !== undefined) return Number(msg.computed_is_send)
  if (msg.is_send !== undefined) return Number(msg.is_send)
  return 0
}

/** 单行截断长度与上下文总长上限（各链路预算不同） */
export interface FormatMessagesOptions {
  /** 单条消息正文的最大字符数 */
  maxLineChars: number
  /** 全部行累计字符上限，超出即停止追加 */
  maxTotalChars: number
}

/**
 * 把消息列表渲染成「发送者：内容」的多行文本。
 * getMessages 返回倒序，故结果按时间正序返回。
 */
export function formatMessages(
  messages: any[],
  peerName: string,
  options: FormatMessagesOptions
): string {
  const lines: string[] = []
  let totalLen = 0

  for (const msg of messages) {
    const content = extractContent(msg)
    if (!content) continue

    const sender = getIsSend(msg) === 1 ? '我' : peerName
    const line = `${sender}：${content.slice(0, options.maxLineChars)}`

    if (totalLen + line.length > options.maxTotalChars) break
    lines.push(line)
    totalLen += line.length + 1
  }

  return lines.reverse().join('\n')
}
