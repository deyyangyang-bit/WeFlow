/**
 * annualReportExportPolicy.ts —— annualReport:exportImages 载荷校验（可单测纯模块）
 *
 * 渲染层传入的 baseDir / folderName / images 全部不可信：这里只做纯校验与解码，
 * 不碰文件系统；目录授权（exportPathAuthorizer）、建目录、写盘由 main.ts handler 负责，
 * 且所有载荷校验必须先于建目录完成，避免无效载荷留下空目录。
 */
import { basename, isAbsolute } from 'path'

export interface AnnualReportExportLimits {
  maxImages: number
  maxImageBytes: number
  maxTotalBytes: number
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

export const ANNUAL_REPORT_EXPORT_LIMITS: AnnualReportExportLimits = {
  maxImages: 64,
  maxImageBytes: 24 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
// Windows 保留设备名（不区分大小写，可带扩展名）；冒号在 Windows 是盘符/ADS 分隔符，
// 尾部点/空格会被 Win32 静默剥离 → 校验过的名字与实际落盘名不一致
const WINDOWS_RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i

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

function decodePngDataUrl(dataUrl: unknown, limits: AnnualReportExportLimits): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('图片数据必须是 PNG data URL')
  }

  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length)
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('图片数据编码无效')
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const estimatedBytes = (base64.length / 4) * 3 - padding
  if (estimatedBytes > limits.maxImageBytes) {
    throw new Error('单张图片超过大小限制')
  }

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length !== estimatedBytes || buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('图片内容不是有效 PNG')
  }
  return buffer
}

export function validateAnnualReportExportPayload(
  payload: unknown,
  limits: AnnualReportExportLimits = ANNUAL_REPORT_EXPORT_LIMITS
): ValidatedAnnualReportExportPayload {
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

    const buffer = decodePngDataUrl(image.dataUrl, limits)
    totalBytes += buffer.length
    if (totalBytes > limits.maxTotalBytes) throw new Error('导出图片总大小超过限制')
    return { name, buffer }
  })

  return { baseDir: raw.baseDir, folderName, images }
}
