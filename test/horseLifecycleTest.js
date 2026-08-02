/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const vec3 = require('vec3')
const assert = require('assert')
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

function setupHorse (bot, vehicleId) {
  const horse = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  horse.name = 'horse'
  horse.position = vec3(0, 64, 0)
  horse.width = 1.3964844
  horse.height = 1.6
  horse.velocity = vec3(0, 0, 0)
  horse.yaw = 0
  horse.pitch = 0
  horse.metadata = new Array(18).fill(0)
  horse.metadata[17] = 0x04
  horse.effects = []
  horse.equipment = []
  horse.attributes = {
    'generic.movement_speed': { value: 0.225, modifiers: [] },
    'horse.jump_strength': { value: 0.7, modifiers: [] }
  }
  bot.entities[vehicleId] = horse
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
  return horse
}

describe('mineflayer_horse_lifecycle 1.17.1v', function () {
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

  it('clears mount state when vehicle entity is removed', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        setupHorse(bot, 100)
        assert(bot.vehicle)
        bot._client.emit('entity_destroy', { entityIds: [100] })
        assert.strictEqual(bot.vehicle, null)
        assert.ok(bot.entity.vehicle == null)
      })
    })
  })

  it('handles forced dismount from position packet', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        setupHorse(bot, 100)
        let dismounted = false
        bot.once('dismount', () => { dismounted = true })
        bot._client.emit('position', {
          x: 1,
          y: 64,
          z: 1,
          yaw: 0,
          pitch: 0,
          flags: bot.supportFeature('positionPacketHasBitflags')
            ? { x: false, y: false, z: false, yaw: false, pitch: false }
            : 0,
          teleportId: 2,
          dismountVehicle: true
        })
        assert.strictEqual(bot.vehicle, null)
        assert(dismounted)
      })
    })
  })

  it('destroys horse context on dismount', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupHorse(bot, 100)
        await once(bot, 'physicsTick')
        assert(bot._horsePhysics.getCtx())
        bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
        assert.strictEqual(bot._horsePhysics.getCtx(), null)
      })
    })
  })
})
