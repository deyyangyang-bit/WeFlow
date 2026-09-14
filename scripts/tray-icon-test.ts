/**
 * Static guard for the packaged tray icon path.
 * This deliberately does not import electron/main.ts, whose module initialization
 * starts the application and touches user data.
 */
import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dirname, '..')
const mainSource = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  build?: { extraResources?: Array<{ from?: string; to?: string }> }
}

const checks: Array<[string, boolean]> = [
  ['macOS Tray does not pass resolveAppIconPath() or an ICNS path directly to Tray',
    !/new Tray\(\s*(?:resolvedTrayIcon|resolveAppIconPath\(\)|[^)]*icon\.icns)/.test(mainSource)],
  ['Tray loads candidates through nativeImage.createFromPath()',
    mainSource.includes('nativeImage.createFromPath(candidate)')],
  ['Tray rejects empty nativeImage results and has a no-icon fallback',
    mainSource.includes('image.isEmpty()') && mainSource.includes('No usable tray icon candidate')],
  ['macOS Tray uses the existing PNG resource and a suitable size',
    mainSource.includes("join(process.resourcesPath, 'icon.png')") &&
    mainSource.includes('width: 18, height: 18') &&
    mainSource.includes('resized.setTemplateImage(false)')],
  ['non-macOS Tray keeps the existing resolveAppIconPath() behavior',
    mainSource.includes("if (process.platform !== 'darwin')") &&
    mainSource.includes('return [resolveAppIconPath()]')],
  ['packaging copies public/icon.png to Resources/icon.png',
    (packageJson.build?.extraResources ?? []).some((entry) =>
      entry.from === 'public/icon.png' && entry.to === 'icon.png')],
  ['source PNG exists and is non-empty', existsSync(join(ROOT, 'public/icon.png'))]
]

for (const [label, passed] of checks) {
  if (!passed) throw new Error(`Tray icon guard failed: ${label}`)
  console.log(`PASS ${label}`)
}

console.log(`tray-icon-test: ${checks.length} passed / 0 failed`)
