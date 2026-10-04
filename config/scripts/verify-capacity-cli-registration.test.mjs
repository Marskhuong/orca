import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const { verifyCapacityCliRegistration } = createRequire(import.meta.url)(
  './verify-capacity-cli-registration.cjs'
)

it.each(['complete', 'spec', 'route', 'handler'])(
  'checks packaged capacity registration: %s',
  (missing) => {
    const out = mkdtempSync(join(tmpdir(), 'orca-capacity-registration-'))
    const keys = ['orchestration run-capacity-record', 'orchestration run-capacity-show']
    try {
      for (const folder of ['specs', 'handlers']) {
        mkdirSync(join(out, 'cli', folder), { recursive: true })
      }
      writeFileSync(
        join(out, 'cli', 'specs', 'index.js'),
        `exports.COMMAND_SPECS = ${JSON.stringify((missing === 'spec' ? keys.slice(1) : keys).map((key) => ({ path: key.split(' ') })))}`
      )
      writeFileSync(
        join(out, 'cli', 'handler-group-manifest.js'),
        `exports.HANDLER_GROUPS = ${JSON.stringify([{ keys: missing === 'route' ? keys.slice(1) : keys }])}`
      )
      writeFileSync(
        join(out, 'cli', 'handlers', 'orchestration.js'),
        `exports.ORCHESTRATION_HANDLERS = {${(missing === 'handler' ? keys.slice(1) : keys).map((key) => `${JSON.stringify(key)}: async () => {}`).join(',')}}`
      )
      if (missing === 'complete') {
        expect(() => verifyCapacityCliRegistration(out)).not.toThrow()
      } else {
        expect(() => verifyCapacityCliRegistration(out)).toThrow(/missing spec, route or handler/)
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }
)
