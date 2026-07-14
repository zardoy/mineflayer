/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const vec3 = require('vec3')
const assert = require('assert')
const { once } = require('../lib/promise_utils')
const { isRideableHorseEntityName } = require('../lib/plugins/entity_physics')

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

function makeRegistryEntity (bot, id, name, position, velocity) {
  const entityTypeData = bot.registry.entitiesByName[name]
  assert(entityTypeData, `expected registry entity for ${name}`)
  return {
    id,
    name,
    type: entityTypeData.type,
    entityType: entityTypeData.id,
    position: position.clone(),
    velocity: velocity.clone(),
    height: name === 'pig' ? 0.9 : 1.6,
    width: name === 'pig' ? 0.9 : 1.3964844,
    metadata: new Array(20).fill(0),
    effects: [],
    equipment: [],
    isValid: true
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

describe('mineflayer_entity_physics horses 1.17.1v', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.17.1'
  let bot
  let server

  beforeEach((done) => {
    ({ server, bot } = setupBotTest(supportedVersion, 25571))
    server.once('listening', () => done())
  })

  afterEach((done) => {
    teardownBotTest(bot, server, done)
  })

  for (const name of ['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse']) {
    it(`does not create entity_physics context for remote ${name}`, (done) => {
      server.on('playerJoin', (client) => {
        withLogin(bot, client, done, async () => {
          stubLoadedWorld(bot, 63)
          const entity = makeRegistryEntity(bot, 100, name, vec3(0, 64, 0), vec3(0, -0.5, 0))
          bot.entities[entity.id] = entity
          const ctx = bot.entityPhysics.syncEntity(entity)
          assert.strictEqual(ctx, null)
          assert.strictEqual(bot.entityPhysics.contexts.has(entity.id), false)
        })
      })
    })

    it(`entityPhysicsTick does not move remote ${name}`, (done) => {
      server.on('playerJoin', (client) => {
        withLogin(bot, client, done, async () => {
          stubLoadedWorld(bot, 63)
          const entity = makeRegistryEntity(bot, 101, name, vec3(0, 64, 0), vec3(0, -0.5, 0))
          bot.entities[entity.id] = entity
          bot.entityPhysics.syncEntity(entity)
          const beforeY = entity.position.y
          bot.emit('entityPhysicsTick')
          assert.strictEqual(entity.position.y, beforeY)
        })
      })
    })
  }

  it('still simulates remote pig on 1.17.1', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot, 63)
        const entity = makeRegistryEntity(bot, 200, 'pig', vec3(0, 64, 0), vec3(0, -0.5, 0))
        bot.entities[entity.id] = entity
        const ctx = bot.entityPhysics.syncEntity(entity)
        assert(ctx)
        assert(bot.entityPhysics.contexts.has(entity.id))
        const beforeY = entity.position.y
        bot.entityPhysics.simulateEntity(entity)
        assert.notStrictEqual(entity.position.y, beforeY)
      })
    })
  })
})

describe('mineflayer_entity_physics horses other versions', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.18.2'
  let bot
  let server

  beforeEach((done) => {
    ({ server, bot } = setupBotTest(supportedVersion, 25572))
    server.once('listening', () => done())
  })

  afterEach((done) => {
    teardownBotTest(bot, server, done)
  })

  it('still simulates horse on 1.18.2', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot, 63)
        const entity = makeRegistryEntity(bot, 300, 'horse', vec3(0, 64, 0), vec3(0, -0.5, 0))
        bot.entities[entity.id] = entity
        const ctx = bot.entityPhysics.syncEntity(entity)
        assert(ctx)
        const beforeY = entity.position.y
        bot.entityPhysics.simulateEntity(entity)
        assert.notStrictEqual(entity.position.y, beforeY)
      })
    })
  })
})

describe('entity_physics horse name helper', () => {
  it('recognizes all rideable horse variants', () => {
    for (const name of ['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse']) {
      assert.strictEqual(isRideableHorseEntityName(name), true)
    }
    assert.strictEqual(isRideableHorseEntityName('pig'), false)
  })
})
