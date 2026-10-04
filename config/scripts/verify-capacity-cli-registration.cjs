const { createRequire } = require('node:module')
const { resolve } = require('node:path')

function verifyCapacityCliRegistration(outDir) {
  const load = createRequire(resolve(outDir, 'cli', 'index.js'))
  const { COMMAND_SPECS } = load('./specs/index.js')
  const { HANDLER_GROUPS } = load('./handler-group-manifest.js')
  const { ORCHESTRATION_HANDLERS } = load('./handlers/orchestration.js')
  for (const command of ['orchestration run-capacity-record', 'orchestration run-capacity-show']) {
    if (
      !COMMAND_SPECS.some((spec) => spec.path.join(' ') === command && !spec.hidden) ||
      !HANDLER_GROUPS.some((group) => group.keys.includes(command)) ||
      typeof ORCHESTRATION_HANDLERS[command] !== 'function'
    ) {
      throw new Error(
        `[verify-capacity-cli-registration] missing spec, route or handler: ${command}`
      )
    }
  }
}

if (require.main === module) {
  verifyCapacityCliRegistration(process.argv[2] ?? 'out')
  console.log('[verify-capacity-cli-registration] record/show specs, routes and handlers passed')
}

module.exports = { verifyCapacityCliRegistration }
