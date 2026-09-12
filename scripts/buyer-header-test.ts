/**
 * buyer-header-test.ts —— 甲方抬头粘贴解析单测（PRD v1.4 §10.1 / §11.1）
 * 覆盖：Gate 0 脱敏 fixture 全用例、名称命中与产品名称不命中的成对用例、
 *       组合标签只识别不拆分、仅命中组合标签判定失败（共享层给结论）、边界输入不抛异常。
 * 运行：npx tsx scripts/buyer-header-test.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseBuyerHeader,
  buyerHeaderOutcome,
  recognizedFieldCount,
  BUYER_HEADER_FIELD_LABELS,
  type BuyerHeader,
} from '../shared/buyerHeader'

let pass = 0, fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) { pass++ } else { fail++; console.error('FAIL:', name) }
}
function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++ } else { fail++; console.error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${e}`) }
}

const FIELDS: Array<keyof BuyerHeader> = ['buyerName', 'taxNo', 'addr', 'phone', 'bank', 'account']

interface FixtureCase {
  name: string
  text: string
  expected: BuyerHeader
  comboCovers: string
}

/** 解析 fixture：`=== CASE: x ===` 分段，`--- expected ---` 之后为预期结果 */
function loadFixture(): FixtureCase[] {
  const raw = readFileSync(join(__dirname, 'fixtures', 'buyer-header-real.txt'), 'utf8')
  const cases: FixtureCase[] = []
  const parts = raw.split(/^=== CASE: (.+) ===$/m)
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const name = parts[i]
    const [text, expectedBlock] = parts[i + 1].split('--- expected ---')
    const expected: BuyerHeader = {}
    let comboCovers = ''
    for (const line of (expectedBlock || '').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const at = trimmed.indexOf('=')
      if (at < 0) continue
      const key = trimmed.slice(0, at), value = trimmed.slice(at + 1)
      if (key === 'comboCovers') comboCovers = value
      else if (value !== '-') expected[key as keyof BuyerHeader] = value
    }
    cases.push({ name: name.trim(), text: text.replace(/^\n/, '').replace(/\n$/, ''), expected, comboCovers })
  }
  return cases
}

function sameFields(actual: BuyerHeader, expected: BuyerHeader): string | null {
  for (const key of FIELDS) {
    if (String(actual[key] ?? '') !== String(expected[key] ?? '')) {
      return `${BUYER_HEADER_FIELD_LABELS[key]}: 期望「${expected[key] ?? ''}」实际「${actual[key] ?? ''}」`
    }
  }
  return null
}

function main(): void {
  // ── 1 Gate 0 脱敏 fixture 全用例 ────────────────────────────────────────────
  const cases = loadFixture()
  ok('1a fixture 读取到全部用例（含组合标签与负面用例）', cases.length >= 14)
  for (const c of cases) {
    const result = parseBuyerHeader(c.text)
    const diff = sameFields(result.fields, c.expected)
    ok(`1b [${c.name}] 六字段与预期一致${diff ? ` —— ${diff}` : ''}`, diff === null)
    const covers = result.comboHits.length
      ? result.comboHits.flatMap((h) => h.covers).join(',')
      : '-'
    ok(`1c [${c.name}] comboHits 覆盖字段与预期一致（${covers}）`, covers === c.comboCovers)
    for (const hit of result.comboHits) {
      ok(`1d [${c.name}] 组合标签原文被保留`, c.text.includes(hit.raw))
    }
  }

  // ── 2 §10.1 名称命中 / 产品名称不命中（成对用例）────────────────────────────
  const pair = parseBuyerHeader('名称: 义乌市杭运供应链管理有限公司\n产品名称: 数控折弯机')
  ok('2a 标签「名称」正确识别为单位名称', pair.fields.buyerName === '义乌市杭运供应链管理有限公司')
  ok('2b 标签「产品名称」不识别为单位名称', parseBuyerHeader('产品名称: 数控折弯机').fields.buyerName === undefined)

  // ── 3 §7.2.4 第 8 条 值内空白按字段区分 ────────────────────────────────────
  const spaced = parseBuyerHeader(
    '纳税人识别号: 9131 0115 MA8S\tSSSS 8H\n' +
    '银行账号: 6900　0000　0000 0000　008\n' +
    '电话: 021-5700 0000\n' +
    '地址: 浙江省义乌市北苑街道 春晗路 1 号\n' +
    '开户银行: 中国工商银行 义乌分行'
  )
  ok('3a 税号去除全部内部空白（含 Tab）', spaced.fields.taxNo === '91310115MA8SSSSS8H')
  ok('3b 账号去除普通空格与全角空格', spaced.fields.account === '6900000000000000008')
  ok('3c 电话去除内部空白', spaced.fields.phone === '021-57000000')
  ok('3d 地址保留内部空格', spaced.fields.addr === '浙江省义乌市北苑街道 春晗路 1 号')
  ok('3e 开户银行保留内部空格', spaced.fields.bank === '中国工商银行 义乌分行')

  // ── 4 §7.2.4 第 9~11 条 标签与值分行 ───────────────────────────────────────
  const twoLine = parseBuyerHeader('单位名称\n临沂顺通物流有限公司\n地址: 山东省临沂市兰山区')
  ok('4a 无冒号标签行读取下一行为值', twoLine.fields.buyerName === '临沂顺通物流有限公司')
  const abandoned = parseBuyerHeader('开户银行:\n银行账号: 456000')
  ok('4b 下一行自身是标签时放弃空值且不消费该行', abandoned.fields.bank === undefined)
  ok('4c 被放弃的下一行仍按标签正常解析', abandoned.fields.account === '456000')

  // ── 5 §7.2.3 组合标签只识别不拆分 ──────────────────────────────────────────
  const combo = parseBuyerHeader('开户行及账号: 中国银行泉州分行 4180000000000004')
  ok('5a 四个字段均不被写入', FIELDS.every((k) => combo.fields[k] === undefined))
  ok('5b comboHits 非空且覆盖字段正确',
    combo.comboHits.length === 1 && combo.comboHits[0].covers.join(',') === 'bank,account')
  ok('5c comboHits 保留原始行', combo.comboHits[0].raw === '开户行及账号: 中国银行泉州分行 4180000000000004')
  ok('5d 组合标签不计入已识别字段数', recognizedFieldCount(combo) === 0)

  // ── 6 §7.2.4 第 14 条 / §10.1 两种失败可区分（共享层给结论，调用方不自行判定）────
  const nothing = parseBuyerHeader('开票资料\n对公收款')
  ok('6a 完全未识别：fields 全空且 comboHits 为空',
    recognizedFieldCount(nothing) === 0 && nothing.comboHits.length === 0)
  ok('6b 仅命中组合标签：fields 全空但 comboHits 非空',
    recognizedFieldCount(combo) === 0 && combo.comboHits.length > 0)
  eq('6c 完全未识别 → ok=false / failure=unrecognized + 该条提示原文',
    buyerHeaderOutcome(nothing),
    { ok: false, failure: 'unrecognized', message: '没识别到抬头信息，请手动填写。' })
  eq('6d 仅命中组合标签 → ok=false / failure=combo_only + 一条说明未识别与待拆分',
    buyerHeaderOutcome(combo),
    { ok: false, failure: 'combo_only', message: '没识别到可用的抬头字段，且检测到合并字段，请手工拆分后填写。' })
  eq('6e 命中任一字段即 ok=true，且不携带 failure',
    buyerHeaderOutcome(parseBuyerHeader('税号: 91330782MA2XXXXX1A')),
    { ok: true, message: '' })
  ok('6f 成功不受组合标签影响（§7.2.3 组合标签不计入成功判定）',
    buyerHeaderOutcome(parseBuyerHeader('税号: 91330782MA2XXXXX1A\n开户行及账号: 中国银行泉州分行')).ok)

  // ── 7 §10.1 边界：空输入与噪音不抛异常 ─────────────────────────────────────
  for (const [name, input] of [['空字符串', ''], ['纯空白', '   \n\t\n  '], ['噪言行', '开票资料\n对公收款信息']] as const) {
    let thrown: unknown = null
    let result: ReturnType<typeof parseBuyerHeader> | null = null
    try { result = parseBuyerHeader(input) } catch (e) { thrown = e }
    ok(`7a [${name}] 不抛异常且返回空结果`,
      thrown === null && result !== null && recognizedFieldCount(result) === 0 && result.comboHits.length === 0)
  }
  ok('7b 非字符串输入不抛异常',
    recognizedFieldCount(parseBuyerHeader(undefined as unknown as string)) === 0)

  // ── 8 §10.1 全角/半角冒号混用、字段乱序、缺项、重复字段取首个非空值 ─────────
  const mixed = parseBuyerHeader('银行账号：1208020009000000001\n单位名称：义乌市杭运供应链管理有限公司')
  ok('8a 全角冒号可解析且字段顺序无关',
    mixed.fields.account === '1208020009000000001' && mixed.fields.buyerName === '义乌市杭运供应链管理有限公司')
  const dup = parseBuyerHeader('地址: 第一个地址\n地址: 第二个地址')
  ok('8b 重复字段只取第一个非空值', dup.fields.addr === '第一个地址')
  const emptyFirst = parseBuyerHeader('地址:\n地址: 第二个地址')
  ok('8c 冒号后为空时下一行非标签则作为值', emptyFirst.fields.addr === '第二个地址')

  // ── 9 §10.1 地址中后续冒号不被截断 ─────────────────────────────────────────
  const colonAddr = parseBuyerHeader('地址: 广东省东莞市南城街道: 三元里路 5 号')
  ok('9a 地址值中的后续冒号原样保留', colonAddr.fields.addr === '广东省东莞市南城街道: 三元里路 5 号')

  // ── 10 §7.2.5 成功提示字段名由非空键推导 ───────────────────────────────────
  const named = parseBuyerHeader('单位名称: 义乌市杭运供应链管理有限公司\n税号: 91330782MA2XXXXX1A')
  const names = (Object.keys(named.fields) as Array<keyof BuyerHeader>).map((k) => BUYER_HEADER_FIELD_LABELS[k])
  ok('10a 识别到的字段名可直接用于成功提示', names.join('、') === '单位名称、税号')
  ok('10b 别名表覆盖六个字段', FIELDS.every((k) => BUYER_HEADER_FIELD_LABELS[k] !== undefined))

  // ── 11 冻结别名表逐条命中 + 负面标签一律不命中（§7.2.2 / §10.1）────────────
  // 别名取自《合同抬头样本分布》§4.1 的冻结表；本表是契约，改了别名这里必须同步改
  const FROZEN_ALIASES: Record<keyof BuyerHeader, string[]> = {
    buyerName: ['名称', '单位名称', '公司名称', '客户名称', '甲方'],
    taxNo: ['税号', '纳税人识别号', '纳税人识别码', '统一社会信用代码'],
    addr: ['地址', '单位地址', '注册地址'],
    phone: ['电话', '电话号码', '联系电话'],
    bank: ['开户银行', '开户行', '开户行名称', '银行'],
    account: ['账号', '帐号', '银行账号', '银行帐号', '开户账号'],
  }
  for (const [field, aliases] of Object.entries(FROZEN_ALIASES) as Array<[keyof BuyerHeader, string[]]>) {
    const missed = aliases.filter((alias) => parseBuyerHeader(`${alias}: 测试值`).fields[field] !== '测试值')
    ok(`11a 别名表[${field}] ${aliases.length} 个标签全部命中`, missed.length === 0)
  }
  const NEGATIVES = ['产品名称', '项目名称', '数字钱包账号', '联行号', '开票资料', '对公收款信息']
  const leaked = NEGATIVES.filter((label) => recognizedFieldCount(parseBuyerHeader(`${label}: 123456`)) > 0)
  ok(`11b 负面标签 ${NEGATIVES.length} 个均不命中（含曾在真实样本中承载过地址/账号的标签）`, leaked.length === 0)

  // ── 12 页面接线（§7.2.5 两处粘贴入口；手工 UI 验收见 §11.2）─────────────────
  const pageSrc = readFileSync(join(__dirname, '..', 'src/pages/CrmWorkbenchPage.tsx'), 'utf8')
  ok('12a 工作台引入共享解析器与字段名表',
    /import \{ parseBuyerHeader, buyerHeaderOutcome, BUYER_HEADER_FIELD_LABELS/.test(pageSrc) &&
    /from '\.\.\/\.\.\/shared\/buyerHeader'/.test(pageSrc))
  ok('12b 新建合同与合同详情两处都有粘贴入口', (pageSrc.match(/\{headerPaste\(/g) || []).length === 2)
  ok('12c 粘贴即解析 + 重新识别 + 清空原文',
    /onPaste=\{\(e\) => \{ const t = e\.clipboardData\.getData\('text'\)/.test(pageSrc) &&
    /重新识别<\/button>/.test(pageSrc) && /清空原文<\/button>/.test(pageSrc))
  ok('12d 新建客户才回填单位名称，已选客户不覆盖档案名',
    /const nameIgnored = newAccountId > 0 && !!f\.buyerName/.test(pageSrc) &&
    /if \(!nameIgnored && f\.buyerName\) \{ setNewName\(f\.buyerName\)/.test(pageSrc))
  ok('12e 合同详情只回填合同字段，不写客户档案',
    /单位名称未修改，仍以客户档案为准。/.test(pageSrc) &&
    !/applyEditHeader[\s\S]{0,900}?setNewName/.test(pageSrc) &&
    !/applyEditHeader[\s\S]{0,900}?crm\.update\('account'/.test(pageSrc))
  ok('12f 两条失败提示由共享层给出、本页只透传（§10.1 调用方不自行判定）',
    (pageSrc.match(/buyerHeaderOutcome\(result\)/g) || []).length === 2 &&
    (pageSrc.match(/text: outcome\.message/g) || []).length === 2 &&
    !/没识别到抬头信息，请手动填写。/.test(pageSrc) &&
    /检测到合并字段，请手工拆分后确认：\{hit\.raw\}/.test(pageSrc))
  ok('12g 换客户/切模式时清掉粘贴原文与旧提示（避免提示与已重置字段不符）',
    /setNewHeaderText\(''\); setNewHeaderNote\(null\)/.test(pageSrc) &&
    /setEditHeaderText\(''\)/.test(pageSrc))
  const scss = readFileSync(join(__dirname, '..', 'src/pages/CrmWorkbenchPage.scss'), 'utf8')
  ok('12h 提示按 §8 语义配色（浅蓝成功/浅黄待处理/浅红未识别）',
    /\.header-paste__hint--ok \{ background:var\(--color-accent-bg\)/.test(scss) &&
    /\.header-paste__hint--warn \{ background:var\(--color-warning-bg\)/.test(scss) &&
    /\.header-paste__hint--fail \{ background:var\(--color-danger-bg\)/.test(scss))

  console.log(`buyer-header: ${pass} pass / ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
