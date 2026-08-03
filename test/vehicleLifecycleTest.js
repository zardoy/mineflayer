/* eslint-env mocha */

const mineflayer = require('../')
const mc = require('minecraft-protocol')
const vec3 = require('vec3')
const assert = require('assert')
const { once } = require('../lib/promise_utils')

for (const supportedVersion of mineflayer.testedVersions) {
  const registry = require('prismarine-registry')(supportedVersion)
  const Block = require('prismarine-block')(supportedVersion)
  const hasSetPassengers = registry.version['>=']('1.9')
  const usesLegacySteerVehicle = !registry.supportFeature('newPlayerInputPacket')

  describe(`mineflayer_vehicle_lifecycle ${supportedVersion}v`, function () {
    this.timeout(10 * 1000)
    let bot
    let server

    beforeEach((done) => {
      server = mc.createServer({
        'online-mode': false,
        version: supportedVersion,
        port: 25568
      })
      server.on('listening', () => {
        bot = mineflayer.createBot({
          username: 'player',
          version: supportedVersion,
          port: 25568
        })
        bot.test = {}
        bot.test.generateLoginPacket = () => {
          if (bot.supportFeature('usesLoginPacket')) {
            const loginPacket = registry.loginPacket
            loginPacket.entityId = 0
            return loginPacket
          }
          return {
            entityId: 0,
            levelType: 'fogetaboutit',
            gameMode: 0,
            previousGameMode: 255,
            worldNames: ['minecraft:overworld'],
            dimension: 0,
            worldName: 'minecraft:overworld',
            hashedSeed: [0, 0],
            difficulty: 0,
            maxPlayers: 20,
            reducedDebugInfo: 1,
            enableRespawnScreen: true
          }
        }
        done()
      })
    })

    afterEach((done) => {
      bot.on('end', () => done())
      server.close()
    })

    function captureWrites () {
      const writes = []
      const oldWrite = bot._client.write
      bot._client.write = function (name, data) {
        writes.push({ name, data })
        return oldWrite.apply(bot._client, arguments)
      }
      return writes
    }

    function loginBot (client) {
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

    function stubPassableWorld () {
      const air = Block.fromStateId(0, 0)
      bot.blockAt = () => air
    }

    function isOutsideBoatHorizontalAabb (x, z, boat) {
      const halfWidth = boat.width / 2
      return Math.abs(x - boat.position.x) > halfWidth || Math.abs(z - boat.position.z) > halfWidth
    }

    function setupBoat (vehicleId, position, name = 'boat') {
      const boat = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
      boat.name = name
      boat.position = position
      boat.width = 1.375
      boat.height = 0.5625
      boat.velocity = vec3(0, 0, 0)
      boat.metadata ??= []
      boat.effects ??= []
      boat.equipment ??= []
      bot.entities[vehicleId] = boat
      bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
      return bot.entities[vehicleId]
    }

    function setupMinecart (vehicleId, position) {
      const minecart = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
      minecart.name = 'minecart'
      minecart.position = position
      minecart.width = 0.98
      minecart.height = 0.7
      minecart.velocity = vec3(0, 0, 0)
      minecart.metadata ??= []
      minecart.effects ??= []
      minecart.equipment ??= []
      bot.entities[vehicleId] = minecart
      bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
      return bot.entities[vehicleId]
    }

    function setupHorse (vehicleId, position) {
      const horse = bot.entities[vehicleId] ?? { id: vehicleId, passengers: [] }
      horse.name = 'horse'
      horse.position = position
      horse.width = 1.4
      horse.height = 1.6
      horse.velocity = vec3(0, 0, 0)
      horse.metadata ??= []
      horse.effects ??= []
      horse.equipment ??= []
      bot.entities[vehicleId] = horse
      bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
      return bot.entities[vehicleId]
    }

    if (usesLegacySteerVehicle) {
      it('moveVehicle(0, 0, false) sends steer_vehicle jump mask 0', (done) => {
        server.on('playerJoin', (client) => {
          loginBot(client)
          const writes = captureWrites()
          bot.moveVehicle(0, 0, false)
          const packet = writes.find(w => w.name === 'steer_vehicle')
          assert(packet, 'expected steer_vehicle packet')
          assert.strictEqual(packet.data.jump, 0)
          done()
        })
      })

      it('moveVehicle(0, 0, true) sends steer_vehicle jump mask 1', (done) => {
        server.on('playerJoin', (client) => {
          loginBot(client)
          const writes = captureWrites()
          bot.moveVehicle(0, 0, true)
          const packet = writes.find(w => w.name === 'steer_vehicle')
          assert(packet, 'expected steer_vehicle packet')
          assert.strictEqual(packet.data.jump, 0x01)
          done()
        })
      })

      it('dismount() sends steer_vehicle jump mask 2', (done) => {
        server.on('playerJoin', (client) => {
          loginBot(client)
          const vehicleId = 42
          bot.entities[vehicleId] = bot.entities[vehicleId] || { id: vehicleId, passengers: [] }
          bot.vehicle = bot.entities[vehicleId]
          const writes = captureWrites()
          bot.dismount()
          const packet = writes.find(w => w.name === 'steer_vehicle')
          assert(packet, 'expected steer_vehicle packet')
          assert.strictEqual(packet.data.jump, 0x02)
          done()
        })
      })

      if (hasSetPassengers) {
        it('keeps dismount bit on steer_vehicle until set_passengers confirms', (done) => {
          server.on('playerJoin', (client) => {
            bot.once('login', async () => {
              bot.blockAt = () => ({})

              const vehicleId = 100
              bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })

              const writes = captureWrites()
              bot.dismount()

              for (let i = 0; i < 4; i++) {
                await once(bot, 'physicsTick')
              }

              const duringDismount = writes.filter(w => w.name === 'steer_vehicle')
              assert(duringDismount.length >= 5, 'expected dismount + physics steer_vehicle packets')
              for (const packet of duringDismount) {
                assert.strictEqual(packet.data.jump & 0x02, 0x02, `expected dismount bit, got jump=${packet.data.jump}`)
                assert.notStrictEqual(packet.data.jump, 0, 'periodic steer_vehicle must not clear dismount bit')
              }

              bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
              assert.strictEqual(bot.vehicle, null)

              writes.length = 0
              bot.moveVehicle(0, 0, false)
              const afterConfirm = writes.filter(w => w.name === 'steer_vehicle')
              assert.strictEqual(afterConfirm.length, 1)
              assert.strictEqual(afterConfirm[0].data.jump, 0)

              done()
            })
            loginBot(client)
          })
        })
      }
    }

    if (hasSetPassengers) {
      it('syncs mounted player state from vehicle on physicsTick', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            // tickPhysics bails when blockAt returns null; stub so the mounted path is testable
            // without version-specific map_chunk wiring.
            bot.blockAt = () => ({})

            const vehicleId = 100
            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
            const vehicle = bot.entities[vehicleId]
            vehicle.position = vec3(1, 63, 2)
            vehicle.velocity = vec3(0.25, 0.1, -0.5)
            vehicle.height = 1
            vehicle.onGround = true
            bot.entity.position.set(0, 50, 0)
            bot.entity.velocity.set(0, -5, 0)
            const positionRef = bot.entity.position

            await once(bot, 'physicsTick')

            assert.strictEqual(bot.entity.position, positionRef, 'position Vec3 must not be replaced')
            assert.strictEqual(bot.entity.position.x, 1)
            assert.strictEqual(bot.entity.position.y, 64)
            assert.strictEqual(bot.entity.position.z, 2)
            assert.strictEqual(bot.entity.velocity.x, 0.25)
            assert.strictEqual(bot.entity.velocity.y, 0.1)
            assert.strictEqual(bot.entity.velocity.z, -0.5)
            assert.strictEqual(bot.entity.onGround, true)
            done()
          })
          loginBot(client)
        })
      })

      it('set_passengers mount and dismount lifecycle', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', () => {
            const vehicleId = 100
            let mountCount = 0
            let dismountCount = 0
            bot.on('mount', () => { mountCount++ })
            bot.on('dismount', () => { dismountCount++ })

            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
            assert.strictEqual(bot.vehicle?.id, vehicleId)
            assert.strictEqual(bot.entity.vehicle?.id, vehicleId)
            assert.strictEqual(mountCount, 1)
            assert.strictEqual(dismountCount, 0)

            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
            assert.strictEqual(mountCount, 1, 'duplicate mount packet must not re-emit mount')
            assert.strictEqual(dismountCount, 0)

            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
            assert.strictEqual(bot.vehicle, null)
            assert.strictEqual(bot.entity.vehicle, undefined)
            assert.strictEqual(mountCount, 1)
            assert.strictEqual(dismountCount, 1)

            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
            assert.strictEqual(dismountCount, 1, 'duplicate dismount packet must not re-emit dismount')

            done()
          })
          loginBot(client)
        })
      })

      it('snaps boat passenger position on mount and emits one move event', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', () => {
            const oldPos = bot.entity.position.clone()
            const moves = []
            bot.on('move', previousPosition => moves.push(previousPosition))

            const boat = setupBoat(100, vec3(1, 63, 2))
            const expectedOffset = registry.isNewerOrEqualTo('1.20.2') ? -0.4125 : -0.45

            assert.strictEqual(bot.entity.position.x, boat.position.x)
            assert.strictEqual(bot.entity.position.y, boat.position.y + expectedOffset)
            assert.strictEqual(bot.entity.position.z, boat.position.z)
            assert.strictEqual(moves.length, 1)
            assert(moves[0].equals(oldPos), 'move event must contain the pre-mount position')
            done()
          })
          loginBot(client)
        })
      })

      if (['1.20.1', '1.20.2', '1.21.4'].includes(supportedVersion)) {
        it('snaps modern minecart passenger position on mount', (done) => {
          server.on('playerJoin', (client) => {
            bot.once('login', async () => {
              bot.entity.position.set(0, 50, 0)
              const oldPos = bot.entity.position.clone()
              const moves = []
              bot.on('move', previousPosition => moves.push(previousPosition))

              const minecart = setupMinecart(100, vec3(1, 63, 2))
              const expectedOffset = supportedVersion === '1.20.1' ? -0.35 : -0.4125

              assert.strictEqual(bot.entity.position.x, minecart.position.x)
              assert.strictEqual(bot.entity.position.y, minecart.position.y + expectedOffset)
              assert.strictEqual(bot.entity.position.z, minecart.position.z)
              assert.strictEqual(moves.length, 1)
              assert(moves[0].equals(oldPos), 'move event must contain the pre-mount position')
              done()
            })
            loginBot(client)
          })
        })
      }

      if (supportedVersion === '1.21.4') {
        it('uses the modern bamboo raft passenger offset', (done) => {
          server.on('playerJoin', (client) => {
            bot.once('login', async () => {
              bot.entity.position.set(0, 50, 0)
              const oldPos = bot.entity.position.clone()
              const moves = []
              bot.on('move', previousPosition => moves.push(previousPosition))

              const raft = setupBoat(100, vec3(1, 63, 2), 'bamboo_raft')

              assert.strictEqual(bot.entity.position.x, raft.position.x)
              assert.ok(Math.abs(bot.entity.position.y - (raft.position.y - 0.1)) < 1e-6)
              assert.strictEqual(bot.entity.position.z, raft.position.z)
              assert.strictEqual(moves.length, 1)
              assert(moves[0].equals(oldPos), 'move event must contain the pre-mount position')
              done()
            })
            loginBot(client)
          })
        })

        it('sends player_input once on input change while riding minecart', (done) => {
          server.on('playerJoin', (client) => {
            bot.once('login', async () => {
              stubPassableWorld()
              await once(bot, 'forcedMove')
              await once(bot, 'physicsTick')

              setupMinecart(100, vec3(0, 63, 0))
              await once(bot, 'physicsTick')

              const writes = captureWrites()

              bot.setControlState('forward', true)
              for (let i = 0; i < 3; i++) {
                await once(bot, 'physicsTick')
              }

              const inputPackets = writes.filter(w => w.name === 'player_input')
              assert.strictEqual(inputPackets.length, 1, 'player_input must be sent only on input change')
              assert.strictEqual(inputPackets[0].data.inputs.forward, true)

              const countAfterForward = inputPackets.length
              for (let i = 0; i < 3; i++) {
                await once(bot, 'physicsTick')
              }
              assert.strictEqual(
                writes.filter(w => w.name === 'player_input').length,
                countAfterForward,
                'holding forward must not emit extra player_input packets'
              )

              bot.clearControlStates()
              done()
            })
            loginBot(client)
          })
        })
      }

      it('preserves the existing horse passenger sync behavior', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            bot.entity.position.set(0, 50, 0)
            bot.blockAt = () => ({})
            const oldPos = bot.entity.position.clone()
            const moves = []
            bot.on('move', previousPosition => moves.push(previousPosition))
            const horse = setupHorse(100, vec3(1, 63, 2))

            if (supportedVersion === '1.17.1') {
              assert.strictEqual(bot.entity.position.y, horse.position.y + 0.85)
              assert.strictEqual(moves.length, 1)
            } else {
              assert(bot.entity.position.equals(oldPos), 'horse mount must not resync immediately')
              assert.strictEqual(moves.length, 0)
            }

            await once(bot, 'physicsTick')
            assert.strictEqual(bot.entity.position.y, supportedVersion === '1.17.1' ? horse.position.y + 0.85 : horse.position.y + horse.height)
            done()
          })
          loginBot(client)
        })
      })

      it('set_passengers removes absent passengers from vehicle.passengers', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', () => {
            const vehicleId = 100
            const otherPassengerId = 200
            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id, otherPassengerId] })

            const vehicle = bot.entities[vehicleId]
            assert.strictEqual(vehicle.passengers.length, 2)

            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [bot.entity.id] })
            assert.strictEqual(vehicle.passengers.length, 1)
            assert.strictEqual(vehicle.passengers[0].id, bot.entity.id)
            assert.strictEqual(bot.entities[otherPassengerId].vehicle, null)

            done()
          })
          loginBot(client)
        })
      })

      it('emits remote passenger attach and detach after updating vehicle state', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', () => {
            const firstVehicleId = 100
            const secondVehicleId = 101
            const passengerId = 200
            const events = []

            bot.on('entityAttach', (passenger, vehicle) => {
              if (passenger.id !== passengerId) return
              events.push({
                type: 'attach',
                vehicleId: vehicle.id,
                passengerVehicleId: passenger.vehicle?.id,
                vehiclePassengerIds: vehicle.passengers.map(({ id }) => id)
              })
            })
            bot.on('entityDetach', (passenger, vehicle) => {
              if (passenger.id !== passengerId) return
              events.push({
                type: 'detach',
                vehicleId: vehicle.id,
                passengerVehicleId: passenger.vehicle?.id ?? null,
                vehiclePassengerIds: vehicle.passengers.map(({ id }) => id)
              })
            })

            bot._client.emit('set_passengers', { entityId: firstVehicleId, passengers: [passengerId] })
            bot._client.emit('set_passengers', { entityId: firstVehicleId, passengers: [passengerId] })
            bot._client.emit('set_passengers', { entityId: secondVehicleId, passengers: [passengerId] })
            bot._client.emit('set_passengers', { entityId: secondVehicleId, passengers: [passengerId] })
            bot._client.emit('set_passengers', { entityId: secondVehicleId, passengers: [] })
            bot._client.emit('set_passengers', { entityId: secondVehicleId, passengers: [] })

            assert.deepStrictEqual(events, [
              { type: 'attach', vehicleId: firstVehicleId, passengerVehicleId: firstVehicleId, vehiclePassengerIds: [passengerId] },
              { type: 'detach', vehicleId: firstVehicleId, passengerVehicleId: null, vehiclePassengerIds: [] },
              { type: 'attach', vehicleId: secondVehicleId, passengerVehicleId: secondVehicleId, vehiclePassengerIds: [passengerId] },
              { type: 'detach', vehicleId: secondVehicleId, passengerVehicleId: null, vehiclePassengerIds: [] }
            ])
            assert.deepStrictEqual(bot.entities[firstVehicleId].passengers, [])
            assert.deepStrictEqual(bot.entities[secondVehicleId].passengers, [])
            assert.strictEqual(bot.entities[passengerId].vehicle, null)

            done()
          })
          loginBot(client)
        })
      })

      it('offsets player outside boat on dismount and keeps them there', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            stubPassableWorld()

            const vehicleId = 100
            const boat = setupBoat(vehicleId, vec3(10, 63, 20))

            await once(bot, 'physicsTick')
            const boatCenterX = boat.position.x
            const boatCenterZ = boat.position.z
            const positionRef = bot.entity.position

            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })

            assert.strictEqual(bot.vehicle, null)
            assert.strictEqual(bot.entity.vehicle, undefined)
            assert.strictEqual(bot.entity.position, positionRef)
            assert.strictEqual(bot.entity.position.y, boat.position.y + boat.height)
            assert.ok(
              isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
              'player must be outside boat horizontal AABB after dismount'
            )

            const afterFirstOffset = bot.entity.position.clone()
            bot._client.emit('set_passengers', { entityId: vehicleId, passengers: [] })
            assert.strictEqual(bot.entity.position.x, afterFirstOffset.x)
            assert.strictEqual(bot.entity.position.y, afterFirstOffset.y)
            assert.strictEqual(bot.entity.position.z, afterFirstOffset.z)

            for (let i = 0; i < 3; i++) {
              await once(bot, 'physicsTick')
            }
            assert.ok(
              isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
              'player must stay outside boat after subsequent physics ticks'
            )
            assert.ok(
              Math.abs(bot.entity.position.x - boatCenterX) > boat.width / 2 ||
              Math.abs(bot.entity.position.z - boatCenterZ) > boat.width / 2,
              'player must not remain at boat center'
            )

            const xBefore = bot.entity.position.x
            const zBefore = bot.entity.position.z
            bot.setControlState('forward', true)
            await once(bot, 'physicsTick')
            await once(bot, 'physicsTick')
            bot.setControlState('forward', false)
            const moved = (bot.entity.position.x - xBefore) ** 2 + (bot.entity.position.z - zBefore) ** 2 > 1e-8
            assert.ok(moved, 'forward control should move player after boat dismount')

            done()
          })
          loginBot(client)
        })
      })
    }

    if (supportedVersion === '1.17.1' && hasSetPassengers) {
      const POST_DISMOUNT_TIMEOUT_MS = 3000

      function makePositionPacket (x, y, z, { dismountVehicle, teleportId }) {
        const packet = {
          x,
          y,
          z,
          yaw: 0,
          pitch: 0,
          flags: bot.supportFeature('positionPacketHasBitflags')
            ? { x: false, y: false, z: false, yaw: false, pitch: false }
            : 0,
          teleportId
        }
        if (dismountVehicle === true) packet.dismountVehicle = true
        return packet
      }

      function boatDismountPosition (boat) {
        return {
          x: boat.position.x,
          y: boat.position.y + boat.height,
          z: boat.position.z
        }
      }

      function assertBoatDismountOutcome (boat, dismountCount) {
        assert.strictEqual(bot.vehicle, null)
        assert.strictEqual(bot.entity.vehicle, undefined)
        assert.strictEqual(dismountCount, 1)
        assert.strictEqual(bot._boatPhysics.getCtx(), null)
        assert.ok(
          isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
          'player must be outside boat horizontal AABB after dismount'
        )
      }

      async function setupMountedBoat (vehicleId, position) {
        stubPassableWorld()
        const boat = setupBoat(vehicleId, position)
        await once(bot, 'physicsTick')
        assert(bot._boatPhysics.getCtx(), 'expected boat physics context while mounted')
        return boat
      }

      it('sequence A: position(dismount) then set_passengers(empty) offsets player outside boat', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            let dismountCount = 0
            bot.on('dismount', () => { dismountCount++ })

            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))
            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })

            assertBoatDismountOutcome(boat, dismountCount)
            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            assertBoatDismountOutcome(boat, dismountCount)

            done()
          })
          loginBot(client)
        })
      })

      it('sequence B: set_passengers(empty) then position(dismount) offsets player outside boat', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            let dismountCount = 0
            bot.on('dismount', () => { dismountCount++ })

            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))

            assertBoatDismountOutcome(boat, dismountCount)
            done()
          })
          loginBot(client)
        })
      })

      it('delayed sequence B: set_passengers then physicsTick then position(dismount) offsets player', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            let dismountCount = 0
            bot.on('dismount', () => { dismountCount++ })

            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            await once(bot, 'physicsTick')
            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))

            assertBoatDismountOutcome(boat, dismountCount)
            done()
          })
          loginBot(client)
        })
      })

      it('position(dismount=false) does not consume pending post-dismount offset', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))

            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            const afterDismount = bot.entity.position.clone()

            bot._client.emit('position', makePositionPacket(12, 64, 22, {
              teleportId: 3
            }))
            assert.strictEqual(bot.entity.position.x, 12)
            assert.strictEqual(bot.entity.position.y, 64)
            assert.strictEqual(bot.entity.position.z, 22)

            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 4
            }))
            assert.ok(
              isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
              'pending offset must still apply on later dismount position packet'
            )
            assert.notStrictEqual(bot.entity.position.x, afterDismount.x)

            done()
          })
          loginBot(client)
        })
      })

      it('reapplies offset for repeated dismount position packets inside boat AABB', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            let dismountCount = 0
            bot.on('dismount', () => { dismountCount++ })

            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            const onBoat = boatDismountPosition(boat)

            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))
            assertBoatDismountOutcome(boat, dismountCount)

            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 3
            }))
            assertBoatDismountOutcome(boat, dismountCount)

            done()
          })
          loginBot(client)
        })
      })

      it('later dismount position outside boat AABB is not re-offset', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))

            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))
            const afterOffset = bot.entity.position.clone()

            bot._client.emit('position', makePositionPacket(15, 64, 25, {
              dismountVehicle: true,
              teleportId: 3
            }))
            assert.strictEqual(bot.entity.position.x, 15)
            assert.strictEqual(bot.entity.position.y, 64)
            assert.strictEqual(bot.entity.position.z, 25)
            assert.notStrictEqual(bot.entity.position.x, afterOffset.x)

            done()
          })
          loginBot(client)
        })
      })

      it('sendPacketPositionAndLook acknowledges server target before post-dismount offset', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            const writes = captureWrites()
            const onBoat = boatDismountPosition(boat)

            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })
            writes.length = 0
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))

            const positionLook = writes.find(w => w.name === 'position_look')
            assert(positionLook, 'expected position_look response')
            assert.strictEqual(positionLook.data.x, onBoat.x)
            assert.strictEqual(positionLook.data.y, onBoat.y)
            assert.strictEqual(positionLook.data.z, onBoat.z)
            assert.ok(
              isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
              'local position must be offset after acknowledgement'
            )

            done()
          })
          loginBot(client)
        })
      })

      it('pending post-dismount state expires after 3 seconds', function (done) {
        this.timeout(6000)
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })

            await new Promise(resolve => setTimeout(resolve, POST_DISMOUNT_TIMEOUT_MS + 100))

            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))

            assert.strictEqual(bot.entity.position.x, onBoat.x)
            assert.strictEqual(bot.entity.position.y, onBoat.y)
            assert.strictEqual(bot.entity.position.z, onBoat.z)
            assert.ok(
              !isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
              'expired pending state must not reapply offset'
            )

            done()
          })
          loginBot(client)
        })
      })

      it('new mount clears stale pending post-dismount state', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('login', async () => {
            const boat = await setupMountedBoat(100, vec3(10, 63, 20))
            bot._client.emit('set_passengers', { entityId: 100, passengers: [] })

            bot._client.emit('set_passengers', { entityId: 100, passengers: [bot.entity.id] })
            await once(bot, 'physicsTick')

            const onBoat = boatDismountPosition(boat)
            bot._client.emit('position', makePositionPacket(onBoat.x, onBoat.y, onBoat.z, {
              dismountVehicle: true,
              teleportId: 2
            }))

            assert.strictEqual(bot.vehicle, null)
            assert.ok(
              isOutsideBoatHorizontalAabb(bot.entity.position.x, bot.entity.position.z, boat),
              'forced dismount after remount must still offset using fresh pending state'
            )

            done()
          })
          loginBot(client)
        })
      })
    }

    if (usesLegacySteerVehicle) {
      it('setControlState sneak only dismounts on press, not release', (done) => {
        server.on('playerJoin', (client) => {
          loginBot(client)
          const vehicleId = 42
          bot.entities[vehicleId] = bot.entities[vehicleId] || { id: vehicleId, passengers: [] }
          bot.vehicle = bot.entities[vehicleId]

          const writes = captureWrites()
          bot.setControlState('sneak', true)
          bot.setControlState('sneak', false)

          const dismountPackets = writes.filter(w => w.name === 'steer_vehicle' && w.data.jump === 0x02)
          assert.strictEqual(dismountPackets.length, 1, 'expected exactly one dismount packet on sneak press')
          done()
        })
      })
    }
  })
}
