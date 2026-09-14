import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function createSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function safeSecretEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
