/**
 * annualReportExportPolicy.ts —— annualReport:exportImages 载荷校验（可单测纯模块）
 *
 * 渲染层传入的 baseDir / folderName / images 全部不可信。校验分两个阶段：
 *   ① 预检（preflightAnnualReportExportPayload）：纯字符串/元数据校验——data URL 前缀、
 *      编码长度上限（在读整个 Base64 之前先按 dataUrl.length 拒绝超大载荷）、字符集与
 *      padding、准确预计解码字节数、单图与总大小限制、文件名规则与查重；不创建任何
 *      解码 Buffer，也不对超大字符串做切片/正则扫描。
 *   ② 解码（decodePreflightedAnnualReportImages）：全部图片预检通过后才逐张
 *      Buffer.from 解码，核对实际字节数与预计一致，再校验 PNG 文件签名。
 * 因此任意一张超限或总量超限时，不会为任何图片创建解码 Buffer。
 * 目录授权（exportPathAuthorizer）、建目录、写盘由 annualReportImageExport.ts 负责。
 */
import { basename, isAbsolute } from 'path'

export interface AnnualReportExportLimits {
  maxImages: number
  maxImageBytes: number
  maxTotalBytes: number
}

export interface PreflightedAnnualReportExportImage {
  name: string
  /** 通过预检的 Base64（尚未解码） */
  base64: string
  /** 按规范 Base64 计算的准确解码字节数 */
  expectedBytes: number
}

export interface PreflightedAnnualReportExportPayload {
  baseDir: string
  folderName: string
  images: PreflightedAnnualReportExportImage[]
}

export interface ValidatedAnnualReportExportImage {
  name: string
  buffer: Buffer
}

export interface ValidatedAnnualReportExportPayload {
  baseDir: string
  folderName: string
  images: ValidatedAnnualReportExportImage[]
}

export const ANNUAL_REPORT_EXPORT_LIMITS: Readonly<AnnualReportExportLimits> = Object.freeze({
  maxImages: 64,
  maxImageBytes: 24 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
})

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
// Windows 保留设备名（不区分大小写，可带扩展名）；冒号在 Windows 是盘符/ADS 分隔符，
// 尾部点/空格会被 Win32 静默剥离 → 校验过的名字与实际落盘名不一致
const WINDOWS_RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i
const BASE64_CHARSET = /^[A-Za-z0-9+/]+={0,2}$/

/** 自定义 limits 必须是正整数，防 NaN/Infinity/0/负数让某项限制失效 */
function requireLimits(limits: AnnualReportExportLimits): void {
  for (const key of ['maxImages', 'maxImageBytes', 'maxTotalBytes'] as const) {
    const value = limits[key]
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error(`导出限制参数 ${key} 无效`)
    }
  }
}

/** n 字节规范 Base64 固定编码为 4*ceil(n/3) 字符：编码长度超过它必然解码超限 */
function maxEncodedLengthForBytes(maxBytes: number): number {
  return 4 * Math.ceil(maxBytes / 3)
}

function isWindowsReservedName(value: string): boolean {
  const dot = value.indexOf('.')
  const stem = dot === -1 ? value : value.slice(0, dot)
  return WINDOWS_RESERVED_STEM.test(stem)
}

function requireLeafName(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label}无效`)
  }
  if (
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    /[. ]$/.test(value) ||
    basename(value) !== value
  ) {
    throw new Error(`${label}必须是单一名称`)
  }
  if (isWindowsReservedName(value)) {
    throw new Error(`${label}不能使用 Windows 保留设备名`)
  }
  return value
}

/** 阶段①：只做预检——不创建解码 Buffer，任意超限在此拒绝 */
export function preflightAnnualReportExportPayload(
  payload: unknown,
  limits: AnnualReportExportLimits = ANNUAL_REPORT_EXPORT_LIMITS
): PreflightedAnnualReportExportPayload {
  requireLimits(limits)
  if (!payload || typeof payload !== 'object') throw new Error('导出参数无效')

  const raw = payload as Record<string, unknown>
  if (typeof raw.baseDir !== 'string' || !isAbsolute(raw.baseDir) || raw.baseDir.includes('\0')) {
    throw new Error('导出目录必须是绝对路径')
  }
  const folderName = requireLeafName(raw.folderName, '报告目录名', 160)
  if (!Array.isArray(raw.images) || raw.images.length === 0 || raw.images.length > limits.maxImages) {
    throw new Error('图片数量无效')
  }

  const seenNames = new Set<string>()
  let totalBytes = 0
  const images = raw.images.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`第 ${index + 1} 张图片参数无效`)
    const image = entry as Record<string, unknown>
    const name = requireLeafName(image.name, `第 ${index + 1} 张图片名称`, 180)
    // `.png` 本身（空主干）也拒绝；大小写不敏感文件系统上按 NFC + 小写折叠查重
    if (!name.toLowerCase().endsWith('.png') || name.length <= 4) throw new Error('导出图片必须使用 .png 扩展名')

    const normalizedName = name.normalize('NFC').toLowerCase()
    if (seenNames.has(normalizedName)) throw new Error('导出图片名称重复')
    seenNames.add(normalizedName)

    const dataUrl = image.dataUrl
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
      throw new Error('图片数据必须是 PNG data URL')
    }
    // 在截取/扫描完整 Base64 之前，先用编码长度上限拒绝超大载荷
    const encodedLength = dataUrl.length - PNG_DATA_URL_PREFIX.length
    if (encodedLength > maxEncodedLengthForBytes(limits.maxImageBytes)) {
      throw new Error('单张图片超过大小限制')
    }

    const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length)
    if (!base64 || base64.length % 4 !== 0 || !BASE64_CHARSET.test(base64)) {
      throw new Error('图片数据编码无效')
    }
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const expectedBytes = (base64.length / 4) * 3 - padding
    if (expectedBytes > limits.maxImageBytes) {
      throw new Error('单张图片超过大小限制')
    }

    totalBytes += expectedBytes
    if (totalBytes > limits.maxTotalBytes) throw new Error('导出图片总大小超过限制')
    return { name, base64, expectedBytes }
  })

  return { baseDir: raw.baseDir, folderName, images }
}

/** 阶段②：全部图片预检通过后才解码——核对实际字节数并校验 PNG 签名 */
export function decodePreflightedAnnualReportImages(
  preflighted: PreflightedAnnualReportExportImage[]
): ValidatedAnnualReportExportImage[] {
  return preflighted.map((image) => {
    const buffer = Buffer.from(image.base64, 'base64')
    if (buffer.length !== image.expectedBytes) throw new Error('图片数据编码无效')
    if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error('图片内容不是有效 PNG')
    }
    return { name: image.name, buffer }
  })
}

/** 完整校验：预检（阶段①）+ 解码（阶段②），返回可直接写盘的载荷 */
export function validateAnnualReportExportPayload(
  payload: unknown,
  limits: AnnualReportExportLimits = ANNUAL_REPORT_EXPORT_LIMITS
): ValidatedAnnualReportExportPayload {
  const preflighted = preflightAnnualReportExportPayload(payload, limits)
  return {
    baseDir: preflighted.baseDir,
    folderName: preflighted.folderName,
    images: decodePreflightedAnnualReportImages(preflighted.images)
  }
}
