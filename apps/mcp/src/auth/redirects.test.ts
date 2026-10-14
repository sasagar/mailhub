import { describe, expect, it } from 'vite-plus/test'
import { isAllowedRedirect } from './redirects.ts'

const origin = 'https://mailhub.bktsk.com'

describe('isAllowedRedirect', () => {
  it('claude.ai・ローカル・mailhub の Web 画面は受け付ける', () => {
    expect(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback', origin)).toBe(true)
    expect(isAllowedRedirect('https://claude.com/api/mcp/auth_callback', origin)).toBe(true)
    expect(isAllowedRedirect('http://localhost:33418/callback', origin)).toBe(true)
    expect(isAllowedRedirect('http://127.0.0.1:8080/cb', origin)).toBe(true)
    expect(isAllowedRedirect('https://mailhub.bktsk.com/app/', origin)).toBe(true)
  })

  it('それ以外や、紛らわしいものは拒否する', () => {
    expect(isAllowedRedirect('https://evil.example/cb', origin)).toBe(false)
    expect(isAllowedRedirect('https://claude.ai.evil.example/cb', origin)).toBe(false)
    expect(isAllowedRedirect('http://claude.ai/cb', origin)).toBe(false)
    expect(isAllowedRedirect('https://user@claude.ai/cb', origin)).toBe(false)
    expect(isAllowedRedirect('https://mailhub.bktsk.com/app/x', origin)).toBe(false)
    expect(isAllowedRedirect('https://localhost/cb', origin)).toBe(false)
    expect(isAllowedRedirect('not a url', origin)).toBe(false)
  })
})
