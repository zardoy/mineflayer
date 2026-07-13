/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const conv = require('../lib/conversions')
const assert = require('assert')

describe('mineflayer_entity_look 1.17.1v', function () {
  this.timeout(10 * 1000)

  const supportedVersion = '1.17.1'
  const registry = require('prismarine-registry')(supportedVersion)
  let bot
  let server

  beforeEach((done) => {
    server = mc.createServer({
      'online-mode': false,
      version: supportedVersion,
      port: 25572
    })
    server.on('listening', () => {
      bot = mineflayer.createBot({
        username: 'player',
        version: supportedVersion,
        port: 25572
      })
      done()
    })
  })

  afterEach((done) => {
    bot.on('end', () => done())
    server.close()
  })

  function loginBot (client) {
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

  function ensureEntity (entityId) {
    if (!bot.entities[entityId]) {
      bot._client.emit('rel_entity_move', { entityId, dX: 0, dY: 0, dZ: 0 })
    }
    return bot.entities[entityId]
  }

  it('updates pitch when yaw byte is 0', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', () => {
        const entityId = 200
        const entity = ensureEntity(entityId)
        entity.yaw = 1.25
        entity.pitch = 0

        bot._client.emit('entity_look', { entityId, yaw: 0, pitch: 64 })

        assert.strictEqual(entity.yaw, conv.fromNotchianYawByte(0))
        assert.strictEqual(entity.pitch, conv.fromNotchianPitchByte(64))
        assert.ok(Number.isFinite(entity.pitch))
        assert.notStrictEqual(entity.pitch, 0)
        done()
      })
      loginBot(client)
    })
  })

  it('updates yaw and zero pitch when pitch byte is 0', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', () => {
        const entityId = 201
        const entity = ensureEntity(entityId)
        entity.yaw = 0
        entity.pitch = 0.75

        bot._client.emit('entity_look', { entityId, yaw: 64, pitch: 0 })

        assert.strictEqual(entity.yaw, conv.fromNotchianYawByte(64))
        assert.strictEqual(entity.pitch, conv.fromNotchianPitchByte(0))
        assert.strictEqual(entity.pitch, 0)
        done()
      })
      loginBot(client)
    })
  })

  it('does not write NaN when yaw or pitch is missing', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', () => {
        const entityId = 202
        const entity = ensureEntity(entityId)
        entity.yaw = 0.5
        entity.pitch = -0.25

        bot._client.emit('entity_look', { entityId, yaw: null, pitch: 32 })
        assert.strictEqual(entity.yaw, 0.5)
        assert.strictEqual(entity.pitch, -0.25)

        bot._client.emit('entity_look', { entityId, yaw: 32, pitch: null })
        assert.strictEqual(entity.yaw, 0.5)
        assert.strictEqual(entity.pitch, -0.25)
        done()
      })
      loginBot(client)
    })
  })

  it('emits entityMoved after rotation update', (done) => {
    server.on('playerJoin', (client) => {
      bot.once('login', () => {
        const entityId = 203
        ensureEntity(entityId)
        let movedEntity = null
        bot.once('entityMoved', (entity) => {
          if (entity.id === entityId) movedEntity = entity
        })

        bot._client.emit('entity_look', { entityId, yaw: 0, pitch: 48 })

        assert.strictEqual(movedEntity?.id, entityId)
        assert.strictEqual(movedEntity.pitch, conv.fromNotchianPitchByte(48))
        done()
      })
      loginBot(client)
    })
  })
})
