/* eslint-env mocha */

const assert = require('assert')
const { spawnSync } = require('child_process')
const path = require('path')
const {
  hasTransportPhysicsCapability,
  resolveTransportPhysicsCapabilities
} = require('../lib/physicsCapabilities')

function runScenario (scenario) {
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

  it('starts with boat exports present and horse exports absent', () => {
    const result = runScenario('boats-only')
    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })

  it('starts with boat and horse exports absent and keeps legacy boat path', () => {
    const result = runScenario('no-transport')
    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })

  it('keeps full transport behavior when all exports are present', () => {
    const result = runScenario('full-transport')
    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })

  it('logs a missing capability warning only once per capability', () => {
    const result = runScenario('warn-once')
    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })
})
