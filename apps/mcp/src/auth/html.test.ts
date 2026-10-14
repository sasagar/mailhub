import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'
import { CONSENT_SCRIPT, CONSENT_SCRIPT_HASH, securityHeaders } from './html.ts'

describe('同意画面のスクリプト', () => {
  it('CSP のハッシュが中身と一致する（違うとブラウザがスクリプトを止める）', () => {
    const hash = `sha256-${createHash('sha256').update(CONSENT_SCRIPT).digest('base64')}`
    expect(hash).toBe(CONSENT_SCRIPT_HASH)
  })
  it('CSP はそのハッシュのスクリプトだけを許す', () => {
    const csp = securityHeaders([]).get('Content-Security-Policy')!
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(scriptSrc.trim()).toBe(`script-src '${CONSENT_SCRIPT_HASH}'`)
  })
})
