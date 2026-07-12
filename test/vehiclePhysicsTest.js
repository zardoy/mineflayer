/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const vec3 = require('vec3')
const assert = require('assert')
const { once } = require('../lib/promise_utils')

function createBlockWorldStub (version, waterSurfaceY = 63) {
  const mcData = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)
  const waterId = mcData.blocksByName.water.id
  const stoneId = mcData.blocksByName.stone.id
  const airId = mcData.blocksByName.air.id
  const cache = new Map()

  return (pos) => {
    const blockPos = pos.floored()
    const key = `${blockPos.x},${blockPos.y},${blockPos.z}`
    const cached = cache.get(key)
    if (cached) return cached

    let type = airId
    if (blockPos.y < waterSurfaceY - 1) {
      type = stoneId
    } else if (blockPos.y === waterSurfaceY - 1) {
      type = waterId
    }
    const block = new Block(type, 0, 0)
    block.position = blockPos
    cache.set(key, block)
    return block
  }
}

function stubLoadedWorld (bot, waterSurfaceY = 63) {
  bot.blockAt = createBlockWorldStub(bot.version, waterSurfaceY)
}

function stubUnloadedWorld (bot) {
  let calls = 0
  const loaded = createBlockWorldStub(bot.version)
  bot.blockAt = (pos) => {
    calls++
    if (calls > 20) return null
    return loaded(pos)
  }
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

function setupBoat (bot, vehicleId, position) {
  const boat = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  boat.name = 'boat'
  boat.position = position.clone ? position.clone() : vec3(position.x, position.y, position.z)
  boat.width = 1.375
  boat.height = 0.5625
  boat.velocity = vec3(0, 0, 0)
  boat.yaw = 0
  boat.pitch = 0
  bot.entities[vehicleId] = boat
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
  return boat
}

function assertNoBoatCtx (bot, message = 'boatCtx must be destroyed') {
  assert.ok(bot._boatPhysics.getCtx() == null, message)
}

function teardownBotAndServer (bot, server, done) {
  let finished = false
  function finish () {
    if (finished) return
    finished = true
    done()
  }

  setTimeout(finish, 3000)

  if (bot && !bot._client.ended) {
    bot.once('end', () => {
      if (server) server.close(() => finish())
      else finish()
    })
    try {
      bot.quit('test teardown')
    } catch (err) {
      if (server) server.close(() => finish())
      else finish()
    }
    return
  }

  if (server) server.close(() => finish())
  else finish()
}

function withLogin (bot, client, done, runTest) {
  bot.once('login', () => {
    void runTest().then(() => done(), done)
  })
  loginBot(bot, client)
}

describe('mineflayer_vehicle_physics 1.17.1v', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.17.1'
  const registry = require('prismarine-registry')(supportedVersion)
  let bot
  let server

  beforeEach((done) => {
    server = mc.createServer({
      'online-mode': false,
      version: supportedVersion,
      port: 25569
    })
    server.on('listening', () => {
      bot = mineflayer.createBot({
        username: 'player',
        version: supportedVersion,
        port: 25569
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
    teardownBotAndServer(bot, server, done)
  })

  it('creates boatCtx for the first passenger', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        assert(bot._boatPhysics.getCtx(), 'expected boat physics context')
        assert.strictEqual(bot._boatPhysics.getCtx().state.constructor.name, 'BoatState')
      })
    })
  })

  it('controls boat when passengers[0] is a duplicate entity object with the same id', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')

        const stalePassengerRef = { id: bot.entity.id, vehicle: boat }
        boat.passengers[0] = stalePassengerRef
        assert.notStrictEqual(boat.passengers[0], bot.entity)
        assert.strictEqual(boat.passengers[0].id, bot.entity.id)

        const beforeZ = boat.position.z
        bot.setControlState('forward', true)
        await once(bot, 'physicsTick')
        bot.setControlState('forward', false)

        assert(bot._boatPhysics.getCtx(), 'expected boat physics context for matching passenger id')
        assert.ok(boat.position.z < beforeZ, 'boat should move when id matches despite stale object reference')
      })
    })
  })

  it('does not control or send movement packets for the second passenger', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const vehicleId = 100
        const boat = setupBoat(bot, vehicleId, vec3(0, 63, 0))
        bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [200, bot.entity.id] })
        assert.strictEqual(bot.vehicle?.id, vehicleId)

        const writes = captureWrites(bot)
        bot.setControlState('forward', true)
        await once(bot, 'physicsTick')
        bot.setControlState('forward', false)

        assertNoBoatCtx(bot)
        assert.strictEqual(writes.filter(w => w.name === 'vehicle_move').length, 0)
        assert.strictEqual(writes.filter(w => w.name === 'steer_boat').length, 0)
        assert.strictEqual(boat.position.z, 0)
      })
    })
  })

  it('moves the boat forward and sends finite vehicle_move', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))
        const writes = captureWrites(bot)
        bot.setControlState('forward', true)
        await once(bot, 'physicsTick')
        bot.setControlState('forward', false)

        const packet = writes.find(w => w.name === 'vehicle_move')
        assert(packet, 'expected vehicle_move')
        assert([packet.data.x, packet.data.y, packet.data.z, packet.data.yaw, packet.data.pitch].every(Number.isFinite))
        assert.ok(boat.position.z < 0, 'boat should move forward in -z')
      })
    })
  })

  it('sends vehicle yaw/pitch in protocol degrees', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))
        boat.yaw = Math.PI / 4
        boat.pitch = -Math.PI / 6
        bot._boatPhysics.getCtx()?.state.rebaseFromEntity(boat)

        const writes = captureWrites(bot)
        await once(bot, 'physicsTick')

        const packet = writes.find(w => w.name === 'vehicle_move')
        assert(packet, 'expected vehicle_move')
        assert.ok(Math.abs(packet.data.yaw) > 10, 'yaw should be in degrees')
        assert.ok(Math.abs(packet.data.pitch) > 5, 'pitch should be in degrees')
        assert.ok(Math.abs(packet.data.yaw) <= 360)
      })
    })
  })

  it('maps paddle states from controls', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupBoat(bot, 100, vec3(0, 63, 0))

        async function paddlesFor (controls) {
          bot.clearControlStates()
          for (const [control, state] of Object.entries(controls)) {
            bot.setControlState(control, state)
          }
          const writes = captureWrites(bot)
          await once(bot, 'physicsTick')
          bot.clearControlStates()
          return writes.find(w => w.name === 'steer_boat')?.data
        }

        assert.deepStrictEqual(await paddlesFor({ forward: true }), { leftPaddle: true, rightPaddle: true })
        assert.deepStrictEqual(await paddlesFor({ back: true }), { leftPaddle: false, rightPaddle: false })
        assert.deepStrictEqual(await paddlesFor({ left: true }), { leftPaddle: false, rightPaddle: true })
        assert.deepStrictEqual(await paddlesFor({ right: true }), { leftPaddle: true, rightPaddle: false })
      })
    })
  })

  it('does not mutate the boat or send prediction when worldReady is false', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))
        stubUnloadedWorld(bot)

        const before = {
          x: boat.position.x,
          y: boat.position.y,
          z: boat.position.z,
          yaw: boat.yaw
        }
        const writes = captureWrites(bot)
        await once(bot, 'physicsTick')

        assert.strictEqual(bot._boatPhysics.getCtx().state.worldReady, false)
        assert.strictEqual(boat.position.x, before.x)
        assert.strictEqual(boat.position.y, before.y)
        assert.strictEqual(boat.position.z, before.z)
        assert.strictEqual(boat.yaw, before.yaw)
        assert.strictEqual(writes.filter(w => w.name === 'vehicle_move').length, 0)
      })
    })
  })

  it('rebases on vehicle_move correction and confirms immediately', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')

        const writes = captureWrites(bot)
        bot._client.emit('vehicle_move', { x: 5, y: 62, z: -3, yaw: 45, pitch: 10 })
        await once(bot, 'physicsTick')

        const confirm = writes.find(w => w.name === 'vehicle_move')
        assert(confirm, 'expected confirm vehicle_move')
        assert.strictEqual(confirm.data.x, 5)
        assert.strictEqual(confirm.data.y, 62)
        assert.strictEqual(confirm.data.z, -3)
        assert.strictEqual(confirm.data.yaw, 45)
        assert.ok(Math.abs(boat.position.x - 5) < 0.5, 'boat x should rebase toward server correction')
      })
    })
  })

  it('replaces velocity on entity_velocity correction', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')

        bot._client.emit('entity_velocity', {
          entityId: 100,
          velocityX: 8000,
          velocityY: 0,
          velocityZ: -8000
        })
        assert.strictEqual(boat.velocity.x, 1)
        assert.strictEqual(boat.velocity.z, -1)

        await once(bot, 'physicsTick')
        assert(bot._boatPhysics.getCtx(), 'boat ctx should remain after velocity correction')
      })
    })
  })

  it('preserves yawVelocity across teleport and relative move corrections', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        const ctx = bot._boatPhysics.getCtx()
        ctx.state.yawVelocity = 0.05

        bot._client.emit('entity_teleport', {
          entityId: 100,
          x: 1,
          y: 63,
          z: 1,
          yaw: 90,
          pitch: 0
        })
        await once(bot, 'physicsTick')
        assert.ok(ctx.state.yawVelocity > 0, 'yawVelocity must not be cleared by teleport rebase')

        bot._client.emit('rel_entity_move', {
          entityId: 100,
          dX: 32,
          dY: 0,
          dZ: 0
        })
        await once(bot, 'physicsTick')
        assert.ok(ctx.state.yawVelocity > 0, 'yawVelocity must not be cleared by relative move rebase')
      })
    })
  })

  it('emits entityMoved for the vehicle once per successful tick', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        const boat = setupBoat(bot, 100, vec3(0, 63, 0))

        const violations = []
        let movedThisTick = 0
        bot.on('entityMoved', (entity) => {
          if (entity === boat) movedThisTick++
        })
        bot.on('physicsTick', () => {
          if (movedThisTick > 1) violations.push(movedThisTick)
          movedThisTick = 0
        })

        for (let i = 0; i < 5; i++) {
          await once(bot, 'physicsTick')
        }

        assert.strictEqual(violations.length, 0, `entityMoved fired ${violations[0]} times in one physics tick`)
      })
    })
  })

  it('destroys boatCtx on dismount, entityGone, and respawn', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        assert(bot._boatPhysics.getCtx())

        bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
        assertNoBoatCtx(bot)

        setupBoat(bot, 101, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        bot._client.emit('entity_destroy', { entityIds: [101] })
        assertNoBoatCtx(bot)

        setupBoat(bot, 102, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        bot.emit('respawn')
        assertNoBoatCtx(bot)
      })
    })
  })

  it('restores normal player physics after dismount', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        bot._client.emit('set_passengers', { entityId: 100, passengers: [] })

        const before = bot.entity.position.clone()
        bot.setControlState('forward', true)
        await once(bot, 'physicsTick')
        await once(bot, 'physicsTick')
        bot.setControlState('forward', false)

        const moved = (bot.entity.position.x - before.x) ** 2 + (bot.entity.position.z - before.z) ** 2
        assert.ok(moved > 1e-8, 'player should move after dismount')
      })
    })
  })

  it('disables local boat physics after three rapid corrections until remount', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        stubLoadedWorld(bot)
        setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')

        const writes = captureWrites(bot)
        for (let i = 0; i < 3; i++) {
          bot._client.emit('vehicle_move', { x: i, y: 63, z: 0, yaw: 0, pitch: 0 })
        }
        await once(bot, 'physicsTick')
        assert.strictEqual(bot._boatPhysics.isDisabled(), true)

        const predictionPackets = writes.filter(w => w.name === 'vehicle_move')
        assert.strictEqual(predictionPackets.length, 3, 'confirm packets only from corrections')

        bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
        await once(bot, 'physicsTick')
        setupBoat(bot, 100, vec3(0, 63, 0))
        await once(bot, 'physicsTick')
        assert.strictEqual(bot._boatPhysics.isDisabled(), false)
      })
    })
  })
})

describe('mineflayer_vehicle_physics legacy boat behavior', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.18.2'
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
    teardownBotAndServer(bot, server, done)
  })

  it('keeps legacy vehicle_move behavior on non-1.17.1 versions', (done) => {
    server.on('playerJoin', (client) => {
      withLogin(bot, client, done, async () => {
        bot.blockAt = createBlockWorldStub(bot.version)
        const boat = bot.entities[100] ?? { id: 100, passengers: [] }
        boat.name = 'boat'
        boat.position = vec3(0, 63, 0)
        boat.width = 1.375
        boat.height = 0.5625
        boat.velocity = vec3(0, 0, 0)
        boat.yaw = 0
        boat.pitch = 0
        bot.entities[100] = boat
        bot._client.emit('set_passengers', { entityId: 100, passengers: [bot.entity.id] })

        const writes = captureWrites(bot)
        await once(bot, 'physicsTick')

        assertNoBoatCtx(bot, 'legacy versions must not create boatCtx')
        assert.ok(writes.some(w => w.name === 'vehicle_move'))
        assert.ok(writes.some(w => w.name === 'steer_boat'))
      })
    })
  })
})
