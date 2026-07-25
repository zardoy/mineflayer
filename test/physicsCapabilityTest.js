/* eslint-env mocha */

const assert = require('assert')
const { spawnSync } = require('child_process')
const path = require('path')
const {
  hasTransportPhysicsCapability,
  resolveTransportPhysicsCapabilities
} = require('../lib/physicsCapabilities')

function runScenarios (scenario = 'all') {
  const script = path.join(__dirname, 'physicsCapabilityScenario.js')
  return spawnSync(process.execPath, [script, scenario], {
    encoding: 'utf8',
    env: process.env
  })
}

describe('physics capability helper', () => {
  it('detects boat capability from constructor and CREATE_FROM_ENTITY', () => {
    class BoatPhysics {}
    const BoatState = { CREATE_FROM_ENTITY () {} }
    assert.strictEqual(hasTransportPhysicsCapability(BoatPhysics, BoatState), true)
  })

  it('rejects partial boat exports', () => {
    class BoatPhysics {}
    assert.strictEqual(hasTransportPhysicsCapability(BoatPhysics, {}), false)
    assert.strictEqual(hasTransportPhysicsCapability(undefined, { CREATE_FROM_ENTITY () {} }), false)
  })

  it('resolves boat-only capabilities from export sets', () => {
    class BoatPhysics {}
    const BoatState = { CREATE_FROM_ENTITY () {} }
    const caps = resolveTransportPhysicsCapabilities({
      BoatPhysics,
      BoatState
    })
    assert.deepStrictEqual(caps, { boat: true, horse: false })
  })
})

describe('physics capability integration', function () {
  this.timeout(60 * 1000)

  it('covers boats-only, legacy fallback, full transport, and warn-once behavior', () => {
    const startedAt = Date.now()
    const result = runScenarios('all')
    const elapsedMs = Date.now() - startedAt
    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
    assert.ok(elapsedMs < 45000, `expected integration scenarios under 45s, took ${elapsedMs}ms`)
  })
})
