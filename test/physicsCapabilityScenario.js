'use strict'

const assert = require('assert')
const vec3 = require('vec3')
const Module = require('module')
const path = require('path')

const scenarioArg = process.argv[2] || 'all'
const scenarios = scenarioArg === 'all'
  ? ['boats-only', 'no-transport', 'full-transport', 'warn-once']
  : [scenarioArg]
const supportedVersion = '1.17.1'
const realUtil = require('@nxg-org/mineflayer-physics-util')

function createStubHorseExports () {
  class StubHorsePhysics {
    constructor (registry) {
      this.registry = registry
      this.data = registry
    }

    simulate (ctx) {
      ctx.state.worldReady = true
    }
  }

  class StubHorseState {
    constructor () {
      this.worldReady = true
      this.vel = { set () {} }
    }

    applyToEntity () {}
    updateControls () {}
    updateFromHorseEntity () {}
    updateJumpCharge () { return null }
    rebaseFromEntity () {}
    clone () { return this }

    static CREATE_FROM_ENTITY (horsePhysics, vehicle) {
      const state = new StubHorseState()
      state.vel = vehicle.velocity || { set () {} }
      return state
    }
  }

  return { HorsePhysics: StubHorsePhysics, HorseState: StubHorseState }
}

function buildExports (mode) {
  const exports = { ...realUtil }
  if (mode === 'boats-only' || mode === 'no-transport' || mode === 'warn-once') {
    delete exports.HorsePhysics
    delete exports.HorseState
  }
  if (mode === 'no-transport' || mode === 'warn-once') {
    delete exports.BoatPhysics
    delete exports.BoatState
  }
  if (mode === 'full-transport') {
    Object.assign(exports, createStubHorseExports())
  }
  return exports
}

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

function setupBoat (bot, vehicleId, position) {
  const boat = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  boat.name = 'boat'
  boat.position = position.clone ? position.clone() : vec3(position.x, position.y, position.z)
  boat.width = 1.375
  boat.height = 0.5625
  boat.velocity = vec3(0, 0, 0)
  boat.yaw = 0
  boat.pitch = 0
  boat.passengers = [bot.entity]
  bot.entities[vehicleId] = boat
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
  return boat
}

function setupHorse (bot, vehicleId, position, options = {}) {
  const horse = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  horse.name = 'horse'
  horse.position = position.clone ? position.clone() : vec3(position.x, position.y, position.z)
  horse.width = 1.3964844
  horse.height = 1.6
  horse.velocity = vec3(0, 0, 0)
  horse.yaw = 0
  horse.pitch = 0
  horse.metadata = new Array(18).fill(0)
  horse.metadata[17] = options.saddled === false ? 0 : 0x04
  horse.attributes = {
    'generic.movement_speed': { value: 0.225, modifiers: [] },
    horse_jump_strength: { value: 0.7, modifiers: [] }
  }
  horse.effects = []
  horse.equipment = []
  horse.passengers = [bot.entity]
  bot.entities[vehicleId] = horse
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
  return horse
}

function dismountVehicle (bot, vehicleId) {
  bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
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

async function runWithMode (mode, runTest) {
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@nxg-org/mineflayer-physics-util') {
      return buildExports(mode)
    }
    return originalLoad.apply(this, arguments)
  }

  const mineflayerRoot = path.join(__dirname, '..')
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(mineflayerRoot)) {
      delete require.cache[key]
    }
  }

  const mineflayer = require('../')
  const mc = require('minecraft-protocol')
  const { once } = require('../lib/promise_utils')

  function withLogin (bot, client, body) {
    return new Promise((resolve, reject) => {
      bot.once('login', async () => {
        try {
          await once(bot, 'forcedMove')
          await body()
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      loginBot(bot, client)
    })
  }

  async function tickPhysics (bot, count = 1) {
    for (let i = 0; i < count; i++) {
      await once(bot, 'physicsTick')
    }
  }

  async function teardownBotAndServer (bot, server) {
    if (bot && !bot._client.ended) {
      await Promise.race([
        once(bot, 'end'),
        new Promise((resolve) => {
          setTimeout(() => {
            try {
              bot._client.end()
            } catch {}
            resolve()
          }, 1000)
        })
      ])
      try {
        bot.quit('scenario teardown')
      } catch {}
    }
    await new Promise((resolve) => server.close(() => resolve()))
  }

  async function withBot (body) {
    const port = 26000 + Math.floor(Math.random() * 1000)
    const registry = require('prismarine-registry')(supportedVersion)
    const server = mc.createServer({
      'online-mode': false,
      version: supportedVersion,
      port
    })

    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })

    let bot
    try {
      await new Promise((resolve, reject) => {
        server.once('playerJoin', (client) => {
          withLogin(bot, client, async () => {
            bot.blockAt = createBlockWorldStub(bot.version)
            await body(bot, { tickPhysics })
          }).then(resolve).catch(reject)
        })

        bot = mineflayer.createBot({
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
      })
    } finally {
      await teardownBotAndServer(bot, server)
    }
  }

  try {
    await runTest(withBot)
  } finally {
    Module._load = originalLoad
  }
}

async function runBoatsOnlyScenario () {
  await runWithMode('boats-only', async (withBot) => {
    await withBot(async (bot, { tickPhysics }) => {
      assert.strictEqual(bot._horsePhysics.getCtx(), null)
      setupBoat(bot, 42, vec3(0, 63, 0))
      await tickPhysics(bot, 2)
      assert.ok(bot._boatPhysics.getCtx(), 'expected local boat context on supported version')

      dismountVehicle(bot, 42)
      bot.entity.position.set(0, 68, 0)
      const horse = setupHorse(bot, 43, vec3(0, 63, 0), { saddled: false })
      assert.strictEqual(bot._horsePhysics.getCtx(), null)
      assert.ok(Math.abs(bot.entity.position.y - (horse.position.y + 0.85)) < 0.01,
        'unsaddled horse passenger sync must work without horse exports')
      await tickPhysics(bot, 1)
      assert.ok(Math.abs(bot.entity.position.y - (horse.position.y + 0.85)) < 0.01,
        'unsaddled horse passenger sync must persist across physics ticks')
    })
  })
}

async function runNoTransportScenario () {
  await runWithMode('no-transport', async (withBot) => {
    await withBot(async (bot, { tickPhysics }) => {
      setupBoat(bot, 42, vec3(0, 63, 0))
      await tickPhysics(bot, 2)
      assert.strictEqual(bot._boatPhysics.getCtx(), null, 'legacy boat path must not create local context')
      assert.strictEqual(bot._horsePhysics.getCtx(), null)
    })
  })
}

async function runFullTransportScenario () {
  await runWithMode('full-transport', async (withBot) => {
    await withBot(async (bot, { tickPhysics }) => {
      setupBoat(bot, 42, vec3(0, 63, 0))
      await tickPhysics(bot, 2)
      assert.ok(bot._boatPhysics.getCtx(), 'expected local boat context when exports are present')

      setupHorse(bot, 43, vec3(2, 63, 0))
      await tickPhysics(bot, 2)
      assert.ok(bot._horsePhysics.getCtx(), 'expected local horse context when exports are present')
      assert.strictEqual(bot._horsePhysics.getCtx().state.constructor.name, 'StubHorseState')
    })
  })
}

async function runWarnOnceScenario () {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => {
    warnings.push(args.join(' '))
    originalWarn.apply(console, args)
  }

  try {
    await runWithMode('warn-once', async (withBot) => {
      await withBot(async (bot) => {
        setupBoat(bot, 42, vec3(0, 63, 0))
        dismountVehicle(bot, 42)
        setupBoat(bot, 42, vec3(0, 63, 0))

        setupHorse(bot, 43, vec3(2, 63, 0))
        dismountVehicle(bot, 43)
        setupHorse(bot, 44, vec3(3, 63, 0))
      })
    })

    const boatWarnings = warnings.filter((line) => line.includes('local boat physics unavailable'))
    const horseWarnings = warnings.filter((line) => line.includes('local horse physics unavailable'))
    assert.strictEqual(boatWarnings.length, 1, `expected one boat warning, got ${boatWarnings.length}`)
    assert.strictEqual(horseWarnings.length, 1, `expected one horse warning, got ${horseWarnings.length}`)
  } finally {
    console.warn = originalWarn
  }
}

const scenarioRunners = {
  'boats-only': runBoatsOnlyScenario,
  'no-transport': runNoTransportScenario,
  'full-transport': runFullTransportScenario,
  'warn-once': runWarnOnceScenario
}

async function main () {
  for (const scenario of scenarios) {
    const runner = scenarioRunners[scenario]
    if (!runner) throw new Error(`unknown scenario: ${scenario}`)
    await runner()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
