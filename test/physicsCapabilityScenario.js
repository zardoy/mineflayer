'use strict'

const assert = require('assert')
const vec3 = require('vec3')
const Module = require('module')
const path = require('path')

const scenario = process.argv[2]
const supportedVersion = '1.17.1'
const realUtil = require('@nxg-org/mineflayer-physics-util')

function buildExports (mode) {
  const exports = { ...realUtil }
  if (mode === 'boats-only' || mode === 'no-transport' || mode === 'warn-once') {
    delete exports.HorsePhysics
    delete exports.HorseState
  }
  if (mode === 'no-transport') {
    delete exports.BoatPhysics
    delete exports.BoatState
  }
  return exports
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@nxg-org/mineflayer-physics-util') {
    return buildExports(scenario)
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

function setupHorse (bot, vehicleId, position) {
  const horse = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
  horse.name = 'horse'
  horse.position = position.clone ? position.clone() : vec3(position.x, position.y, position.z)
  horse.width = 1.3964844
  horse.height = 1.6
  horse.velocity = vec3(0, 0, 0)
  horse.yaw = 0
  horse.pitch = 0
  horse.metadata = new Array(18).fill(0)
  horse.metadata[17] = 0x04
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

function withLogin (bot, client, runTest) {
  return new Promise((resolve, reject) => {
    bot.once('login', async () => {
      try {
        await once(bot, 'forcedMove')
        await runTest()
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

async function withBot (runTest) {
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
      server.on('playerJoin', (client) => {
        withLogin(bot, client, async () => {
          bot.blockAt = createBlockWorldStub(bot.version)
          await runTest(bot)
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
    if (bot && !bot._client.ended) {
      bot.quit('scenario teardown')
      await once(bot, 'end')
    }
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main () {
  if (scenario === 'boats-only') {
    await withBot(async (bot) => {
      assert.strictEqual(bot._horsePhysics.getCtx(), null)
      setupBoat(bot, 42, vec3(0, 63, 0))
      await tickPhysics(bot, 2)
      assert.ok(bot._boatPhysics.getCtx(), 'expected local boat context on supported version')
    })
    return
  }

  if (scenario === 'no-transport') {
    await withBot(async (bot) => {
      setupBoat(bot, 42, vec3(0, 63, 0))
      await tickPhysics(bot, 2)
      assert.strictEqual(bot._boatPhysics.getCtx(), null, 'legacy boat path must not create local context')
      assert.strictEqual(bot._horsePhysics.getCtx(), null)
    })
    return
  }

  if (scenario === 'full-transport') {
    await withBot(async (bot) => {
      setupBoat(bot, 42, vec3(0, 63, 0))
      await tickPhysics(bot, 2)
      assert.ok(bot._boatPhysics.getCtx(), 'expected local boat context when exports are present')
    })
    return
  }

  if (scenario === 'warn-once') {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => {
      warnings.push(args.join(' '))
      originalWarn.apply(console, args)
    }
    try {
      await withBot(async (bot) => {
        setupHorse(bot, 43, vec3(0, 63, 0))
      })
      const horseWarnings = warnings.filter((line) => line.includes('local horse physics unavailable'))
      assert.strictEqual(horseWarnings.length, 1)
    } finally {
      console.warn = originalWarn
    }
    return
  }

  throw new Error(`unknown scenario: ${scenario}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
