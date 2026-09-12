/**
 * ExportV2 — Progress utility functions
 * Pure functions for progress normalization, comparison, and formatting.
 */

import type { TaskProgress, ExportTask, ExportProgress } from '../types'

// ─── Progress comparison ─────────────────────────────────────

// ─── Progress normalization ──────────────────────────────────

const normalizeProgressFloat = (value: unknown, digits = 3): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  const factor = 10 ** digits
  return Math.round(parsed * factor) / factor
}

const normalizeProgressInt = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

// ─── Progress payload signature (for dedup) ──────────────────

export const buildProgressPayloadSignature = (payload: ExportProgress): string => ([
  String(payload.phase || ''),
  String(payload.currentSessionId || ''),
  String(payload.currentSession || ''),
  String(payload.phaseLabel || ''),
  normalizeProgressFloat(payload.current, 4),
  normalizeProgressFloat(payload.total, 4),
  normalizeProgressFloat(payload.phaseProgress, 2),
  normalizeProgressFloat(payload.phaseTotal, 2),
  normalizeProgressInt(payload.collectedMessages),
  normalizeProgressInt(payload.exportedMessages),
  normalizeProgressInt(payload.estimatedTotalMessages),
  normalizeProgressInt(payload.writtenFiles),
  normalizeProgressInt(payload.mediaDoneFiles),
  normalizeProgressInt(payload.mediaCacheHitFiles),
  normalizeProgressInt(payload.mediaCacheMissFiles),
  normalizeProgressInt(payload.mediaCacheFillFiles),
  normalizeProgressInt(payload.mediaDedupReuseFiles),
  normalizeProgressInt(payload.mediaBytesWritten)
].join('|'))

// ─── Task status helpers ─────────────────────────────────────

// ─── Background task progress parsing ────────────────────────

export const parseBackgroundTaskProgress = (progressText?: string): {
  current: number
  total: number
  ratio: number | null
} => {
  const normalized = String(progressText || '').trim()
  if (!normalized) return { current: 0, total: 0, ratio: null }
  const match = normalized.match(/(\d+)\s*\/\s*(\d+)/)
  if (!match) return { current: 0, total: 0, ratio: null }
  const current = Math.max(0, Math.floor(Number(match[1]) || 0))
  const total = Math.max(0, Math.floor(Number(match[2]) || 0))
  if (total <= 0) return { current, total, ratio: null }
  return {
    current,
    total,
    ratio: Math.max(0, Math.min(1, current / total))
  }
}

// ─── Task scope helpers ──────────────────────────────────────

export const isTextBatchTask = (task: ExportTask): boolean =>
  task.payload.scope === 'content' && task.payload.contentType === 'text'

// ─── Task open directory resolution ──────────────────────────

import { resolveParentDir } from './format'
