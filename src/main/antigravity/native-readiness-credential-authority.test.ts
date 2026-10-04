import { describe, expect, it } from 'vitest'
import { antigravityConsumerAuthorityDigest } from './native-readiness-credential-authority'
import type { AntigravityNativeCredential } from './native-credential-codec'

function credential(change: Record<string, unknown> = {}): AntigravityNativeCredential {
  return {
    authMethod: 'consumer',
    identity: { issuer: 'https://accounts.google.com', subject: 'account', email: null },
    contents: JSON.stringify({
      auth_method: 'consumer',
      id_token: 'cached-id',
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry: 'old',
        token_type: 'Bearer',
        ...change
      }
    })
  }
}
describe('stable native consumer authority', () => {
  it('allows the same account to refresh a cached access token', () => {
    expect(
      antigravityConsumerAuthorityDigest(
        credential({ access_token: 'new', expiry: 'new', id_token: 'refreshed' })
      )
    ).toBe(antigravityConsumerAuthorityDigest(credential()))
  })
  it('binds refresh authority and unknown credential selector fields', () => {
    for (const changed of [
      credential({ refresh_token: 'other' }),
      credential({ gateway: 'other' }),
      {
        ...credential(),
        identity: { issuer: 'https://accounts.google.com' as const, subject: 'other', email: null }
      }
    ]) {
      expect(antigravityConsumerAuthorityDigest(changed)).not.toBe(
        antigravityConsumerAuthorityDigest(credential())
      )
    }
  })
  it('refuses missing refresh authority and a different auth method', () => {
    expect(() => antigravityConsumerAuthorityDigest(credential({ refresh_token: '' }))).toThrow()
    expect(() =>
      antigravityConsumerAuthorityDigest({ ...credential(), authMethod: 'api_key' })
    ).toThrow()
  })
})
