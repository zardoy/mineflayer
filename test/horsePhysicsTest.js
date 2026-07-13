/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const vec3 = require('vec3')
const assert = require('assert')
const conv = require('../lib/conversions')
const { once } = require('../lib/promise_utils')

function createBlockWorldStub (version, groundY = 63) {
  const mcData = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)
  const stoneId = mcData.blocksByName.stone.id
  const airId = mcData.blocksByName.air.id
  const cache = new Map()

  return (pos) => {
    const blockPos = pos.floored()
    const key = `${blockPos.x},${blockPos.y},${blockPos.z}`
    const cached = cache.get(key)
    if (cached) return cached

    const type = blockPos.y < groundY ? stoneId : airId
    const block = new Block(type, 0, 0)
    block.position = blockPos
    cache.set(key, block)
    return block
  }
}

function stubLoadedWorld (bot, groundY = 63) {
  bot.blockAt = createBlockWorldStub(bot.version, groundY)
}

function captureWrites (bot) {
  const writes = []
  const oldWrite = bot._client.write
  bot._client.write = function (name, data) {
    writes.push({ name, data })
    return oldWrite.apply(bot._client, arguments)
  }
  return writes
}

function loginBot (bot, client) {
  client.write('login', bot.test.generateLoginPacket())
  client.write('position', {
    x: 0,
    y: 64,
    z: 0,
    yaw: 0,
    pitch: 0,
    flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
    teleportId: 1
  })
}

function setupHorse (bot, vehicleId, position, options = {}) {
  const horse = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  horse.name = options.name ?? 'horse'
  horse.position = position.clone ? position.clone() : vec3(position.x, position.y, position.z)
  horse.width = options.width ?? 1.3964844
  horse.height = options.height ?? 1.6
  horse.velocity = vec3(0, 0, 0)
  horse.yaw = 0
  horse.pitch = 0
  horse.metadata = options.metadata ?? new Array(18).fill(0)
  horse.metadata[17] = options.saddled === false ? 0 : 0x04
  horse.attributes = options.attributes ?? {
    'generic.movement_speed': { value: 0.225, modifiers: [] },
    'horse.jump_strength': { value: 0.7, modifiers: [] }
  }
  horse.effects ??= []
  horse.equipment ??= []
  bot.entities[vehicleId] = horse
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
  return horse
}

function withLogin (bot, client, done, runTest) {
  bot.once('login', async () => {
    try {
      await once(bot, 'forcedMove')
      await runTest()
      done()
    } catch (err) {
      done(err)
    }
  })
  loginBot(bot, client)
}

describe('mineflayer_horse_physics 1.17.1v', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.17.1'
  const registry = require('prismarine-registry')(supportedVersion)
  let bot
  let server

  beforeEach((done) => {
    server = mc.createServer({
      'online-mode': false,
      version: supportedVersion,
      port: 25570
    })
    server.on('listening', () => {
      bot = mineflayer.createBot({
        username: 'player',
        version: supportedVersion,
        port: 25570
      })
      bot.test = {}
      bot.test.generateLoginPacket = () => {
        const loginPacket = registry.loginPacket
        loginPacket.entityId = 0
        return loginPacket
      }
      done()
    })
  })

  afterEach((done) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      done()
    }
    setTimeout(finish, 3000)
    if (bot && !bot._client.ended) {
      bot.once('end', () => server.close(() => finish()))
      try {
        bot.quit('test teardown')
      } catch {
        server.close(() => finish())
      }
      return
    }
    if (server) server.close(() => finish())
    else finish()
  })

  it('creates horse context for saddled first passenger', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupHorse(bot, 100, vec3(0, 64, 0))
        await once(bot, 'physicsTick')
        assert(bot._horsePhysics.getCtx())
        assert.strictEqual(bot._horsePhysics.getCtx().state.constructor.name, 'HorseState')
      })
    })
  })

  it('does not control horse without saddle', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupHorse(bot, 100, vec3(0, 64, 0), { saddled: false })
        assert.strictEqual(bot._horsePhysics.getCtx(), null)
      })
    })
  })

  it('does not control horse as second passenger', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const horse = setupHorse(bot, 100, vec3(0, 64, 0))
        bot._client.emit('set_passengers', { entityId: 100, passengers: [200, bot.entity.id] })
        await once(bot, 'physicsTick')
        assert.strictEqual(bot.vehicle?.id, 100)
        assert.strictEqual(bot._horsePhysics.getCtx(), null)
        assert.strictEqual(horse.position.z, 0)
      })
    })
  })

  it('sends look, steer_vehicle, and vehicle_move with notchian degrees', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupHorse(bot, 100, vec3(0, 64, 0))
        bot.entity.yaw = Math.PI / 4
        const writes = captureWrites(bot)
        bot.setControlState('forward', true)
        await once(bot, 'physicsTick')
        bot.setControlState('forward', false)

        const names = writes.map(w => w.name)
        const lookIdx = names.indexOf('look')
        const steerIdx = names.indexOf('steer_vehicle')
        const moveIdx = names.lastIndexOf('vehicle_move')
        assert.ok(lookIdx >= 0)
        assert.ok(steerIdx > lookIdx)
        assert.ok(moveIdx > steerIdx)
        const packet = writes[moveIdx]
        assert(packet, 'expected vehicle_move')
        assert.ok(Math.abs(conv.toNotchianYaw(bot.vehicle.yaw)) > 10, 'horse yaw should follow rider look')
        assert.ok(Math.abs(packet.data.yaw) > 10)
        assert.ok(Math.abs(packet.data.pitch) <= 90)
      })
    })
  })

  it('uses left-positive sideways in steer_vehicle', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupHorse(bot, 100, vec3(0, 64, 0))
        bot.setControlState('left', true)
        const writes = captureWrites(bot)
        await once(bot, 'physicsTick')
        const steer = writes.find(w => w.name === 'steer_vehicle')
        assert(steer)
        assert.ok(steer.data.sideways > 0)
      })
    })
  })

  it('sends START_RIDING_JUMP on jump release', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupHorse(bot, 100, vec3(0, 64, 0))
        bot.setControlState('jump', true)
        await once(bot, 'physicsTick')
        const writes = captureWrites(bot)
        bot.setControlState('jump', false)
        await once(bot, 'physicsTick')
        const action = writes.find(w => w.name === 'entity_action' && w.data.actionId === 5)
        assert(action, 'expected START_RIDING_JUMP')
        assert.ok(Number.isInteger(action.data.jumpBoost))
        assert.ok(action.data.jumpBoost >= 0 && action.data.jumpBoost <= 100)
        assert.strictEqual(writes.some(w => w.name === 'entity_action' && w.data.actionId === 6), false)
        const names = writes.map(w => w.name)
        const lookIdx = names.indexOf('look')
        const actionIdx = writes.indexOf(action)
        const steerIdx = names.indexOf('steer_vehicle')
        const moveIdx = names.indexOf('vehicle_move')
        assert.ok(lookIdx >= 0)
        assert.ok(actionIdx > lookIdx)
        assert.ok(steerIdx > actionIdx)
        assert.ok(moveIdx > steerIdx)
      })
    })
  })

  it('rebases on vehicle_move correction and echoes packet', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const horse = setupHorse(bot, 100, vec3(0, 64, 0))
        await once(bot, 'physicsTick')
        const writes = captureWrites(bot)
        bot._client.emit('vehicle_move', { x: 2, y: 64, z: 3, yaw: 45, pitch: 10 })
        const echo = writes.find(w => w.name === 'vehicle_move')
        assert(echo)
        assert.strictEqual(echo.data.x, 2)
        assert.strictEqual(horse.position.x, 2)
      })
    })
  })

  it('accepts entity_velocity as knockback correction', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const horse = setupHorse(bot, 100, vec3(0, 64, 0))
        await once(bot, 'physicsTick')
        bot._client.emit('entity_velocity', { entityId: 100, velocityX: 1000, velocityY: 500, velocityZ: -1000 })
        assert.notStrictEqual(horse.velocity.x, 0)
      })
    })
  })

  it('ignores rel_entity_move for controlled horse', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const horse = setupHorse(bot, 100, vec3(0, 64, 0))
        await once(bot, 'physicsTick')
        const before = horse.position.clone()
        bot._client.emit('rel_entity_move', { entityId: 100, dX: 320, dY: 0, dZ: 0 })
        assert.strictEqual(horse.position.x, before.x)
      })
    })
  })

  it('anchors player seat at vanilla horse feet offset', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const horse = setupHorse(bot, 100, vec3(1, 64, 2))
        await once(bot, 'physicsTick')
        assert.ok(Math.abs(bot.entity.position.y - (horse.position.y + 0.85)) < 0.01)
      })
    })
  })
})
