/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const vec3 = require('vec3')
const assert = require('assert')
const { once } = require('../lib/promise_utils')

const MINECART_VARIANTS = [
  'minecart',
  'chest_minecart',
  'furnace_minecart',
  'hopper_minecart',
  'tnt_minecart',
  'spawner_minecart',
  'command_block_minecart'
]

const MAX_VEHICLE_MOVE_COMPONENT = 0.9800000190734863

function captureWrites (bot) {
  const writes = []
  const oldWrite = bot._client.write
  bot._client.write = function (name, data) {
    writes.push({ name, data })
    return oldWrite.apply(bot._client, arguments)
  }
  return writes
}

function loginBot (bot, client, registry) {
  client.write('login', (() => {
    const loginPacket = registry.loginPacket
    loginPacket.entityId = 0
    return loginPacket
  })())
  client.write('position', {
    x: 0,
    y: 64,
    z: 0,
    yaw: 0,
    pitch: 0,
    flags: { x: false, y: false, z: false, yaw: false, pitch: false },
    teleportId: 1
  })
}

function setupMinecart (bot, vehicleId, name, position) {
  const minecart = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  minecart.name = name
  minecart.position = position.clone ? position.clone() : vec3(position.x, position.y, position.z)
  minecart.width = 0.98
  minecart.height = 0.7
  minecart.velocity = vec3(0, 0, 0)
  minecart.yaw = 0
  minecart.pitch = 0
  minecart.metadata ??= []
  minecart.effects ??= []
  minecart.equipment ??= []
  bot.entities[vehicleId] = minecart
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
  return minecart
}

function stubLoadedWorld (bot) {
  const Block = require('prismarine-block')(bot.version)
  const air = Block.fromStateId(0, 0)
  bot.blockAt = () => air
}

async function completeLoginHandshake (bot) {
  await once(bot, 'forcedMove')
  await once(bot, 'physicsTick')
}

describe('mineflayer_minecart_lifecycle 1.17.1v', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.17.1'
  const registry = require('prismarine-registry')(supportedVersion)
  let bot
  let server

  beforeEach((done) => {
    server = mc.createServer({
      'online-mode': false,
      version: supportedVersion,
      port: 25571
    })
    server.on('listening', () => {
      bot = mineflayer.createBot({
        username: 'player',
        version: supportedVersion,
        port: 25571
      })
      done()
    })
  })

  afterEach((done) => {
    bot.on('end', () => done())
    server.close()
  })

  it('syncs player position on entityMoved before the next physics tick', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        await completeLoginHandshake(bot)

        const minecart = setupMinecart(bot, 100, 'minecart', vec3(0, 63, 0))
        await once(bot, 'physicsTick')

        const writes = captureWrites(bot)
        let moveCount = 0
        bot.on('move', () => { moveCount++ })

        bot._client.emit('rel_entity_move', {
          entityId: 100,
          dX: 4096,
          dY: 0,
          dZ: 0
        })

        assert.ok(Math.abs(minecart.position.x - 1) < 0.01)
        assert.ok(Math.abs(bot.entity.position.x - 1) < 0.01, 'player X should sync on entityMoved')
        assert.ok(Math.abs(bot.entity.position.y - 62.65) < 0.01, 'player Y should sync on entityMoved')
        assert.ok(moveCount >= 1, 'expected move event before next physics tick')

        const positionAfterEntityMoved = bot.entity.position.clone()
        await once(bot, 'physicsTick')
        assert.ok(positionAfterEntityMoved.equals(bot.entity.position), 'physics tick must not revert synced position')

        const movesBeforeLook = moveCount
        bot._client.emit('entity_look', { entityId: 100, yaw: 64, pitch: 0 })
        assert.strictEqual(moveCount, movesBeforeLook, 'entity_look without movement must not emit move')

        assert.strictEqual(writes.filter(w => w.name === 'vehicle_move').length, 0)
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('keeps physics tick active after mount and follows server minecart movement', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        await completeLoginHandshake(bot)

        const mountPosition = vec3(0, 63, 0)
        const minecart = setupMinecart(bot, 100, 'minecart', mountPosition)
        bot.entity.position.set(0, 64, 0)

        const writes = captureWrites(bot)
        let moveEvents = 0
        bot.on('move', () => { moveEvents++ })

        await once(bot, 'physicsTick')

        bot._client.emit('rel_entity_move', {
          entityId: 100,
          dX: 4096,
          dY: 0,
          dZ: 4096
        })
        assert.ok(Math.abs(minecart.position.x - 1) < 0.01)
        assert.ok(Math.abs(minecart.position.z - 1) < 0.01)

        await once(bot, 'physicsTick')

        assert.ok(Math.abs(bot.entity.position.x - 1) < 0.01, 'player X should follow minecart')
        assert.ok(Math.abs(bot.entity.position.y - 62.65) < 0.01, 'player Y should follow minecart')
        assert.ok(Math.abs(bot.entity.position.z - 1) < 0.01, 'player Z should follow minecart')
        assert.ok(moveEvents > 0, 'expected move events while riding minecart')
        assert.strictEqual(writes.filter(w => w.name === 'vehicle_move').length, 0)
        assert.ok(writes.some(w => w.name === 'steer_vehicle'), 'expected steer_vehicle packets')
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('dismount after movement keeps player near minecart not original mount point', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        await completeLoginHandshake(bot)

        const originalMountPoint = vec3(0, 64, 0)
        bot.entity.position.set(originalMountPoint.x, originalMountPoint.y, originalMountPoint.z)

        const vehicleId = 100
        const minecart = setupMinecart(bot, vehicleId, 'minecart', vec3(0, 63, 0))

        await once(bot, 'physicsTick')

        bot._client.emit('rel_entity_move', {
          entityId: vehicleId,
          dX: 8192,
          dY: 0,
          dZ: 4096
        })
        await once(bot, 'physicsTick')

        const positionBeforeDismount = bot.entity.position.clone()
        assert.ok(
          Math.abs(positionBeforeDismount.x - 2) < 0.05 &&
          Math.abs(positionBeforeDismount.z - 1) < 0.05,
          'player should already be near moving minecart before dismount'
        )
        assert.ok(
          (positionBeforeDismount.x - originalMountPoint.x) ** 2 +
          (positionBeforeDismount.z - originalMountPoint.z) ** 2 > 0.5,
          'player should have moved away from original mount point'
        )

        bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
        assert.strictEqual(bot.vehicle, null)

        assert.ok(
          Math.abs(bot.entity.position.x - positionBeforeDismount.x) < 0.01 &&
          Math.abs(bot.entity.position.y - positionBeforeDismount.y) < 0.01 &&
          Math.abs(bot.entity.position.z - positionBeforeDismount.z) < 0.01,
          'dismount must not snap player back to original mount point'
        )
        assert.ok(
          Math.abs(bot.entity.position.x - minecart.position.x) < 0.1 &&
          Math.abs(bot.entity.position.z - minecart.position.z) < 0.1,
          'player should remain near minecart after dismount'
        )
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('set_passengers mounts bot in minecart', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', () => {
        const vehicleId = 100
        let mountCount = 0
        const oldPos = bot.entity.position.clone()
        const moves = []
        bot.on('mount', () => { mountCount++ })
        bot.on('move', previousPosition => moves.push(previousPosition))

        const minecart = setupMinecart(bot, vehicleId, 'minecart', vec3(0, 63, 0))

        assert.strictEqual(bot.vehicle?.id, vehicleId)
        assert.strictEqual(bot.entity.vehicle?.id, vehicleId)
        assert.strictEqual(mountCount, 1)
        assert.strictEqual(bot.entity.position.y, minecart.position.y - 0.35)
        assert.strictEqual(moves.length, 1)
        assert(moves[0].equals(oldPos), 'move event must contain the pre-mount position')
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('does not send vehicle_move during routine physics ticks', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        setupMinecart(bot, 100, 'minecart', vec3(0, 63, 0))
        const writes = captureWrites(bot)

        for (let i = 0; i < 4; i++) {
          await once(bot, 'physicsTick')
        }

        assert.strictEqual(writes.filter(w => w.name === 'vehicle_move').length, 0)
        assert.ok(writes.some(w => w.name === 'steer_vehicle'), 'expected steer_vehicle packets')
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('sends non-zero steer_vehicle input from controlState on every physics tick', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        await completeLoginHandshake(bot)

        setupMinecart(bot, 100, 'minecart', vec3(0, 63, 0))
        await once(bot, 'physicsTick')

        const writes = captureWrites(bot)

        bot.setControlState('forward', true)
        for (let i = 0; i < 3; i++) {
          await once(bot, 'physicsTick')
        }

        const forwardPackets = writes.filter(w => w.name === 'steer_vehicle')
        assert.ok(forwardPackets.length >= 3, 'expected steer_vehicle on each physics tick')
        for (const packet of forwardPackets) {
          assert.strictEqual(packet.data.forward, MAX_VEHICLE_MOVE_COMPONENT, 'forward must be the clamped impulse while W is held')
          assert.strictEqual(packet.data.sideways, 0)
        }

        bot.setControlState('forward', false)
        bot.setControlState('left', true)
        await once(bot, 'physicsTick')

        const lastPacket = writes.filter(w => w.name === 'steer_vehicle').at(-1)
        assert(lastPacket, 'expected steer_vehicle after switching to left')
        assert.strictEqual(lastPacket.data.forward, 0)
        assert.strictEqual(lastPacket.data.sideways, MAX_VEHICLE_MOVE_COMPONENT, 'left must produce the clamped positive sideways impulse')

        bot.clearControlStates()
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('syncs bot.entity.position from minecart on physics tick', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        const minecart = setupMinecart(bot, 100, 'minecart', vec3(1, 63, 2))
        minecart.height = 0.7
        bot.entity.position.set(0, 50, 0)

        await once(bot, 'physicsTick')

        assert.strictEqual(bot.entity.position.x, 1)
        assert.strictEqual(bot.entity.position.y, 62.65)
        assert.strictEqual(bot.entity.position.z, 2)
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('rel_entity_move updates minecart position and syncs player on next physics tick', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        const minecart = setupMinecart(bot, 100, 'minecart', vec3(0, 63, 0))

        bot._client.emit('rel_entity_move', {
          entityId: 100,
          dX: 4096,
          dY: 0,
          dZ: 0
        })
        assert.ok(Math.abs(minecart.position.x - 1) < 0.01)

        await once(bot, 'physicsTick')
        assert.ok(Math.abs(bot.entity.position.x - 1) < 0.01)
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('entity_move_look updates minecart position and rotation', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', async () => {
        stubLoadedWorld(bot)
        const minecart = setupMinecart(bot, 100, 'minecart', vec3(0, 63, 0))

        bot._client.emit('entity_move_look', {
          entityId: 100,
          dX: 4096,
          dY: 0,
          dZ: 4096,
          yaw: 64,
          pitch: 0
        })

        assert.ok(Math.abs(minecart.position.x - 1) < 0.01)
        assert.ok(Math.abs(minecart.position.z - 1) < 0.01)
        assert.ok(Number.isFinite(minecart.yaw))

        await once(bot, 'physicsTick')
        assert.ok(Math.abs(bot.entity.position.x - 1) < 0.01)
        assert.ok(Math.abs(bot.entity.position.z - 1) < 0.01)
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  it('empty set_passengers completes mount lifecycle', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', () => {
        const vehicleId = 100
        let mountCount = 0
        let dismountCount = 0
        bot.on('mount', () => { mountCount++ })
        bot.on('dismount', () => { dismountCount++ })

        setupMinecart(bot, vehicleId, 'minecart', vec3(0, 63, 0))
        assert.strictEqual(mountCount, 1)

        bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
        assert.strictEqual(bot.vehicle, null)
        assert.strictEqual(bot.entity.vehicle, undefined)
        assert.strictEqual(mountCount, 1)
        assert.strictEqual(dismountCount, 1)
        done()
      })
      loginBot(bot, client, registry)
    })
  })

  for (const variant of MINECART_VARIANTS) {
    it(`classifies ${variant} as server-authoritative minecart`, (done) => {
      server.on('playerJoin', (client) => {
        bot.once('login', async () => {
          stubLoadedWorld(bot)
          setupMinecart(bot, 100, variant, vec3(0, 63, 0))
          const writes = captureWrites(bot)
          await once(bot, 'physicsTick')
          assert.strictEqual(writes.filter(w => w.name === 'vehicle_move').length, 0)
          assert.ok(writes.some(w => w.name === 'steer_vehicle'))
          done()
        })
        loginBot(bot, client, registry)
      })
    })
  }
})
