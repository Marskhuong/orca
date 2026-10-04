import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AntigravityNativeCredential } from './native-credential-codec'

const StoredCredential = z
  .object({
    auth_method: z.literal('consumer'),
    id_token: z.string().optional(),
    token: z.object({ refresh_token: z.string().min(1) }).passthrough()
  })
  .passthrough()

export function antigravityConsumerAuthorityDigest(
  credential: AntigravityNativeCredential
): string {
  if (credential.authMethod !== 'consumer' || !credential.identity) {
    throw new Error('unsupported_auth_identity')
  }
  const stored = StoredCredential.parse(JSON.parse(credential.contents))
  delete stored.id_token
  for (const field of ['access_token', 'expiry', 'token_type', 'id_token']) {
    delete stored.token[field]
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        stored,
        identity: {
          issuer: credential.identity.issuer,
          subject: credential.identity.subject
        }
      })
    )
    .digest('hex')
}
