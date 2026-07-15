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

function makeRegistryEntity (bot, id, name, position, velocity, dimensions = {}) {
  const entityTypeData = bot.registry.entitiesByName[name]
  assert(entityTypeData, `expected registry entity for ${name}`)
  return {
    id,
    name,
    type: entityTypeData.type,
    entityType: entityTypeData.id,
    position: position.clone(),
    velocity: velocity.clone(),
    height: dimensions.height ?? (name === 'pig' ? 0.9 : 1.6),
    width: dimensions.width ?? (name === 'pig' ? 0.9 : 1.3964844),
    metadata: new Array(20).fill(0),
    effects: [],
    equipment: [],
    isValid: true,
    passengers: []
  }
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

function setupBotTest (supportedVersion, port) {
  const registry = require('prismarine-registry')(supportedVersion)
  const server = mc.createServer({
    'online-mode': false,
    version: supportedVersion,
    port
  })
  const bot = mineflayer.createBot({
    username: 'player',
    version: supportedVersion,
    port
  })
  bot.test = {}
  bot.test.generateLoginPacket = () => {
    const loginPacket = registry.loginPacket
    loginPacket.entityId = 0
    return loginPacket
  }
  return { server, bot }
}

function teardownBotTest (bot, server, done) {
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
}

async function assertMountedVehicleExcludedFromGenericPhysics (bot, vehicle, neighbor) {
  const vehicleYBefore = vehicle.position.y
  const neighborYBefore = neighbor.position.y

  assert(bot.entityPhysics.syncEntity(vehicle), 'expected generic context before mount')
  assert(bot.entityPhysics.syncEntity(neighbor), 'expected generic context for neighbor')
  assert(bot.entityPhysics.contexts.has(vehicle.id))
  assert(bot.entityPhysics.contexts.has(neighbor.id))

  bot._client.emit('set_passengers', { entityId: vehicle.id, passengers: [bot.entity.id] })
  assert.strictEqual(bot.vehicle, vehicle)

  await once(bot, 'physicsTickBegin')

  assert.strictEqual(bot.entityPhysics.contexts.has(vehicle.id), false, 'mounted vehicle context must be removed')
  assert.strictEqual(vehicle.position.y, vehicleYBefore, 'generic physics must not move mounted vehicle')
  assert(bot.entityPhysics.contexts.has(neighbor.id), 'neighbor context must remain')
  assert.notStrictEqual(neighbor.position.y, neighborYBefore, 'neighbor must keep simulating')
}

describe('mineflayer_entity_physics mounted vehicles', function () {
  this.timeout(10 * 1000)

  describe('1.18.2 legacy boat', function () {
    let bot
    let server

    beforeEach((done) => {
      ({ server, bot } = setupBotTest('1.18.2', 25573))
      server.once('listening', () => done())
    })

    afterEach((done) => {
      teardownBotTest(bot, server, done)
    })

    it('drops generic context and skips simulation after mount', (done) => {
      server.on('playerJoin', (client) => {
        withLogin(bot, client, done, async () => {
          stubLoadedWorld(bot)
          const boat = makeRegistryEntity(
            bot, 100, 'boat', vec3(0, 63, 0), vec3(0, -0.5, 0),
            { height: 0.5625, width: 1.375 }
          )
          const neighbor = makeRegistryEntity(bot, 200, 'pig', vec3(5, 64, 0), vec3(0, -0.5, 0))
          bot.entities[boat.id] = boat
          bot.entities[neighbor.id] = neighbor

          await assertMountedVehicleExcludedFromGenericPhysics(bot, boat, neighbor)
        })
      })
    })
  })

  describe('1.17.1 minecart', function () {
    let bot
    let server

    beforeEach((done) => {
      ({ server, bot } = setupBotTest('1.17.1', 25574))
      server.once('listening', () => done())
    })

    afterEach((done) => {
      teardownBotTest(bot, server, done)
    })

    it('drops generic context and skips simulation after mount', (done) => {
      server.on('playerJoin', (client) => {
        withLogin(bot, client, done, async () => {
          stubLoadedWorld(bot)
          const minecart = makeRegistryEntity(
            bot, 100, 'minecart', vec3(0, 64, 0), vec3(0, -0.5, 0),
            { height: 0.7, width: 0.98 }
          )
          const neighbor = makeRegistryEntity(bot, 200, 'pig', vec3(5, 64, 0), vec3(0, -0.5, 0))
          bot.entities[minecart.id] = minecart
          bot.entities[neighbor.id] = neighbor

          await assertMountedVehicleExcludedFromGenericPhysics(bot, minecart, neighbor)
        })
      })
    })
  })
})
