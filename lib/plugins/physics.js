const { Vec3 } = require('vec3')
const assert = require('assert')
const conv = require('../conversions')
const math = require('../math')
const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')
const physicsUtil = require('@nxg-org/mineflayer-physics-util')
const {
  BotcraftPhysics,
  EPhysicsCtx,
  PhysicsWorldSettings,
  initSetup,
  convertPlayerState,
  applyToPlayerState,
  BoatPhysics,
  BoatState,
  HorsePhysics,
  HorseState,
  ControlStateHandler
} = physicsUtil
const { resolveTransportPhysicsCapabilities } = require('../physicsCapabilities')
const { JavaFloat } = require('../javamath')

const mouseSensitivity = 100.0
// default is 0.5F (corresponds to 100%), so we just translate according to that
const rawSensitivity = new JavaFloat(mouseSensitivity).divide(new JavaFloat(200.0))
const f = rawSensitivity.multiply(new JavaFloat(0.6)).add(new JavaFloat(0.2))
const roundingGCD = new JavaFloat(0.15).multiply(new JavaFloat(8.0)).multiply(f).multiply(f).multiply(f)

const DEFAULT_PHYSICS_INTERVAL_MS = 50
const DEFAULT_PHYSICS_TIMESTEP = DEFAULT_PHYSICS_INTERVAL_MS / 1000
// Vanilla LocalPlayer.sendPosition uses a 2.0E-4 squared-distance threshold,
// not the server-side 0.03 movement lenience.
const MIN_DELTA_DIST_SQUARED = 4.0E-8
const BOAT_DISMOUNT_YAW_OFFSETS = [0, Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4]
const MAX_BOAT_DISMOUNT_DISTANCE = 2.5
const BOAT_PHYSICS_VERSION = '1.17.1'
const HORSE_PHYSICS_VERSION = '1.17.1'
const BOAT_CORRECTION_LIMIT = 3
const BOAT_CORRECTION_WINDOW_MS = 1000
const HORSE_CORRECTION_LIMIT = 3
const HORSE_CORRECTION_WINDOW_MS = 1000
const MAX_BOAT_PASSENGER_YAW_OFFSET = 105 * Math.PI / 180
const BOAT_PHYS_DEBUG = !!process.env.BOAT_PHYS_DEBUG
const MAX_VEHICLE_MOVE_COMPONENT = 0.9800000190734863
const RIDEABLE_MINECART_ENTITY_NAMES = new Set([
  'minecart',
  'chest_minecart',
  'furnace_minecart',
  'hopper_minecart',
  'tnt_minecart',
  'spawner_minecart',
  'command_block_minecart'
])
const RIDEABLE_HORSE_ENTITY_NAMES = new Set([
  'horse',
  'donkey',
  'mule',
  'skeleton_horse',
  'zombie_horse'
])
const HORSE_DISMOUNT_YAW_OFFSETS = [Math.PI / 2, -Math.PI / 2, 0, Math.PI / 8, -Math.PI / 8]
const POST_DISMOUNT_TIMEOUT_MS = 3000

function isRideableMinecartEntity (entity) {
  return entity != null && RIDEABLE_MINECART_ENTITY_NAMES.has(entity.name)
}

function isRideableHorseEntity (entity) {
  return entity != null && RIDEABLE_HORSE_ENTITY_NAMES.has(entity.name)
}

function horseSaddleFlag (entity) {
  const flags = entity?.metadata?.[17]
  return typeof flags === 'number' && (flags & 0x04) !== 0
}

function isServerAuthoritativeMinecart (vehicle) {
  return isRideableMinecartEntity(vehicle)
}

function checkInputEquality (oldInput, newInput) {
  const oldKeys = Object.keys(oldInput)
  const newKeys = Object.keys(newInput)
  if (oldKeys.length !== newKeys.length) return false
  for (const key of oldKeys) {
    if (oldInput[key] !== newInput[key]) return false
  }
  return true
}

function cloneInput (input) {
  return {
    forward: input.forward,
    back: input.back,
    left: input.left,
    right: input.right,
    jump: input.jump,
    sprint: input.sprint,
    sneak: input.sneak
  }
}

function deltaYawRadians (yaw1, yaw2) {
  const PI = Math.PI
  const PI_2 = Math.PI * 2
  let dYaw = (yaw1 - yaw2) % PI_2
  if (dYaw < -PI) dYaw += PI_2
  else if (dYaw > PI) dYaw -= PI_2
  return dYaw
}

function deltaYawDegrees (yaw1, yaw2) {
  let dYaw = new JavaFloat((yaw1.subtract(yaw2)) % new JavaFloat(360))
  if (dYaw.valueOf() < -180) dYaw = dYaw.add(new JavaFloat(360))
  else if (dYaw.valueOf() > 180) dYaw = dYaw.subtract(new JavaFloat(360))
  return dYaw
}

function setAngleDegrees (bot, newYaw, newPitch, autoround = true) {
  if (typeof bot.entity.yawDegrees === 'undefined') {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
  }

  if (autoround) {
    const dYaw = deltaYawDegrees(new JavaFloat(newYaw), bot.entity.yawDegrees)
    const normYaw = bot.entity.yawDegrees.add(dYaw)
    bot.entity.yawDegrees = normYaw.divide(roundingGCD).round().multiply(roundingGCD)
    bot.entity.pitchDegrees = new JavaFloat(newPitch).divide(roundingGCD).round().multiply(roundingGCD)
  } else {
    bot.entity.yawDegrees = new JavaFloat(newYaw)
    bot.entity.pitchDegrees = new JavaFloat(newPitch)
  }

  bot.entity.pitchDegrees = bot.entity.pitchDegrees.clamp(new JavaFloat(-90.0), new JavaFloat(90.0))
  bot.entity.yaw = conv.fromNotchianYaw(bot.entity.yawDegrees)
  bot.entity.pitch = conv.fromNotchianPitch(bot.entity.pitchDegrees)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {*} param1
 */
function inject (bot, { physicsEnabled, maxCatchupTicks }) {
  const POSITION_EVERY_N_TICKS = (bot.version === '1.21.5' ? 19 : 20)
  const PHYSICS_CATCHUP_TICKS = maxCatchupTicks ?? 4
  const world = { getBlock: (pos) => bot.blockAt(pos, false) }

  const transportCapabilities = resolveTransportPhysicsCapabilities(physicsUtil)
  const boatCapabilityAvailable = transportCapabilities.boat
  const horseCapabilityAvailable = transportCapabilities.horse
  let warnedMissingBoatCapability = false
  let warnedMissingHorseCapability = false

  const physics = new BotcraftPhysics(bot.registry)
  const boatPhysics = boatCapabilityAvailable ? new BoatPhysics(bot.registry) : null
  const horsePhysics = horseCapabilityAvailable ? new HorsePhysics(bot.registry) : null
  initSetup(bot.registry)

  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')

  bot.jumpQueued = false
  bot.jumpTicks = 0

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }

  let lastSentYaw = null
  let lastSentPitch = null
  let doPhysicsTimer = null
  let lastPhysicsFrameTime = null
  let shouldUsePhysics = false
  bot.physicsEnabled = physicsEnabled ?? true
  let deadTicks = 21
  let physicsIntervalMs = DEFAULT_PHYSICS_INTERVAL_MS
  let physicsTimestep = DEFAULT_PHYSICS_TIMESTEP

  const settings = new PhysicsWorldSettings(bot.registry)
  settings.yawSpeed = 6000 // default speed is 60 for upstream mineflayer * 20. Bumped to allow instant turns.
  settings.pitchSpeed = 6000
  settings.overrides = {}

  /**
   * @type {EPhysicsCtx<PlayerState> | undefined}
   */
  let ectx

  /**
   * @type {import('@nxg-org/mineflayer-physics-util').EPhysicsCtx<import('@nxg-org/mineflayer-physics-util').BoatState> | null}
   */
  let boatCtx = null
  let boatVehicleId = null
  let boatPhysicsDisabled = false
  let boatPhysicsDisabledLogged = false
  /** @type {{ kind: string, replaceVelocity: boolean } | null} */
  let pendingBoatCorrection = null
  let boatCorrectionCount = 0
  let boatCorrectionWindowStart = 0
  let boatTickPacketsReady = false
  /** @type {Record<string, number>} */
  const boatDebugCorrectionCounts = {}

  /**
   * @type {import('@nxg-org/mineflayer-physics-util').EPhysicsCtx<import('@nxg-org/mineflayer-physics-util').HorseState> | null}
   */
  let horseCtx = null
  let horseVehicleId = null
  let horsePhysicsDisabled = false
  let horsePhysicsDisabledLogged = false
  /** @type {{ kind: string, replaceVelocity: boolean } | null} */
  let pendingHorseCorrection = null
  let horseCorrectionCount = 0
  let horseCorrectionWindowStart = 0
  let horseTickPacketsReady = false
  /** @type {{ released: boolean, jumpBoost: number } | null} */
  let pendingHorseJumpRelease = null

  let lastSent = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    ticker: POSITION_EVERY_N_TICKS,
    flags: { onGround: false, hasHorizontalCollision: false },
    sprintState: false,
    sneakState: false,
    previousInputState: cloneInput(controlState)
  }

  let elytraFlyTask = createDoneTask()
  let elytraFlyTimeout = null
  let pendingElytraFly = false
  let forceElytraFly = false
  let resolveForcedElytraFlyImmediately = false
  let speculativeElytraFly = false
  let elytraTakeoffControl = null

  bot._lastSent = lastSent

  const lastUpdated = {
    yaw: 0,
    pitch: 0
  }

  let timeAccumulator = 0
  let catchupTicks = 0

  function getHorizontalCollision () {
    return !!(bot.entity.horizontalCollision ?? bot.entity.isCollidedHorizontally)
  }

  function setPendingElytraFlyRequestState (enabled) {
    if (bot.entity == null) return
    bot.entity._pendingElytraFlyRequest = enabled
  }

  function isElytraTakeoffControlActive () {
    return elytraTakeoffControl != null && (pendingElytraFly || speculativeElytraFly)
  }

  function hasConfirmedElytraFlightState () {
    return (bot.entity.fallFlying || bot.entity.elytraFlying) &&
      bot.entity._pendingElytraFlightConfirmation !== true
  }

  function startElytraTakeoffControl (assistTakeoff) {
    if (elytraTakeoffControl != null) return

    elytraTakeoffControl = {
      previousControls: cloneInput(controlState),
      overrideMovement: assistTakeoff === true,
      phase: (bot.entity.onGround || lastSent.onGround)
        ? (controlState.jump ? 'ground_release' : 'ground_jump')
        : (controlState.jump ? 'air_release' : 'air_press')
    }
  }

  function clearElytraTakeoffControl () {
    if (elytraTakeoffControl == null) return

    const { previousControls, overrideMovement } = elytraTakeoffControl
    elytraTakeoffControl = null

    controlState.jump = previousControls.jump
    if (overrideMovement) {
      for (const key of Object.keys(previousControls)) {
        if (key === 'jump') continue
        controlState[key] = previousControls[key]
      }
    }
  }

  function advanceElytraTakeoffControlBeforePackets () {
    if (elytraTakeoffControl == null) return

    // Vanilla clears the glide flag when gliding is no longer valid rather than
    // treating every local fallFlying flip as authoritative; see
    // LivingEntity.updateFallFlying()/canGlide() in 1.21.4. Keep the takeoff
    // controller alive until flight is speculative or confirmed so the
    // START_FLYING_WITH_ELYTRA packet is not dropped while a stale local
    // fall-flying bit is still set. Grim is sensitive to that packet/input
    // ordering and will see an orphaned pending request as invalid.
    if (speculativeElytraFly || hasConfirmedElytraFlightState() || !pendingElytraFly) {
      clearElytraTakeoffControl()
      return
    }

    if (elytraTakeoffControl.overrideMovement) {
      controlState.forward = true
      controlState.back = false
      controlState.left = false
      controlState.right = false
      controlState.sprint = true
      controlState.sneak = false
    }

    if (elytraTakeoffControl.phase === 'ground_release') {
      controlState.jump = false
      return
    }

    if (elytraTakeoffControl.phase === 'ground_jump') {
      if (!controlState.jump) {
        controlState.jump = true
        bot.jumpQueued = true
      }
      return
    }

    if (elytraTakeoffControl.phase === 'air_release') {
      controlState.jump = false
      return
    }

    if (elytraTakeoffControl.phase === 'air_press' && !controlState.jump) {
      controlState.jump = true
      bot.jumpQueued = true
    }
  }

  function advanceElytraTakeoffControlAfterPackets () {
    if (elytraTakeoffControl == null) return

    if (speculativeElytraFly || hasConfirmedElytraFlightState() || !pendingElytraFly) {
      clearElytraTakeoffControl()
      return
    }

    if ((elytraTakeoffControl.phase === 'air_release' || elytraTakeoffControl.phase === 'air_press') &&
        bot.entity.onGround && lastSent.onGround) {
      elytraTakeoffControl.phase = controlState.jump ? 'ground_release' : 'ground_jump'
      return
    }

    if (elytraTakeoffControl.phase === 'ground_release') {
      if (lastSent.previousInputState.jump === false) {
        elytraTakeoffControl.phase = 'ground_jump'
      }
      return
    }

    if (elytraTakeoffControl.phase === 'ground_jump') {
      if (!bot.entity.onGround && !lastSent.onGround) {
        elytraTakeoffControl.phase = 'air_release'
      }
      return
    }

    if (elytraTakeoffControl.phase === 'air_release' && lastSent.previousInputState.jump === false) {
      elytraTakeoffControl.phase = 'air_press'
    }
  }

  function restartPhysicsTimer () {
    if (doPhysicsTimer === null) return
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = setInterval(doPhysics, physicsIntervalMs)
  }

  function doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
    lastPhysicsFrameTime = now

    timeAccumulator += deltaSeconds
    catchupTicks = 0
    while (timeAccumulator >= physicsTimestep) {
      tickPhysics(now)
      timeAccumulator -= physicsTimestep
      catchupTicks++
      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
    }
  }

  function getHorsePassengerFeetOffsetY (horse) {
    const height = horse.height ?? 1.6
    let variantOffset = 0
    if (horse.name === 'donkey' || horse.name === 'mule') {
      variantOffset = 0.25
    } else if (horse.name === 'skeleton_horse') {
      variantOffset = 0.1875
    }
    return height * 0.75 - variantOffset - 0.35
  }

  function syncEntityWithHorse () {
    const vehicle = bot.vehicle
    if (!vehicle) return

    bot.entity.position.set(
      vehicle.position.x,
      vehicle.position.y + getHorsePassengerFeetOffsetY(vehicle),
      vehicle.position.z
    )

    const vehicleVelocity = vehicle.velocity
    bot.entity.velocity.set(
      vehicleVelocity?.x ?? 0,
      vehicleVelocity?.y ?? 0,
      vehicleVelocity?.z ?? 0
    )
    bot.entity.onGround = vehicle.onGround ?? false
  }

  function syncEntityWithVehicle () {
    const vehicle = bot.vehicle
    if (!vehicle) return

    bot.entity.position.set(
      vehicle.position.x,
      vehicle.position.y + (vehicle.height ?? 0),
      vehicle.position.z
    )

    const vehicleVelocity = vehicle.velocity
    bot.entity.velocity.set(
      vehicleVelocity?.x ?? 0,
      vehicleVelocity?.y ?? 0,
      vehicleVelocity?.z ?? 0
    )
    bot.entity.onGround = vehicle.onGround ?? false
  }

  function isSolidBlockAt (pos) {
    const block = bot.blockAt(pos, false)
    if (block == null) return false
    if (block.type === 0 || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      return false
    }
    return true
  }

  function isOutsideHorizontalEntityAabb (x, z, entity) {
    const halfWidth = (entity.width ?? 0) / 2
    if (halfWidth <= 0) return false
    const dx = Math.abs(x - entity.position.x)
    const dz = Math.abs(z - entity.position.z)
    return dx > halfWidth || dz > halfWidth
  }

  function isValidBoatDismountPosition (x, y, z, boat) {
    if (!isOutsideHorizontalEntityAabb(x, z, boat)) return false
    if (isSolidBlockAt(new Vec3(x, y, z))) return false
    if (isSolidBlockAt(new Vec3(x, y + 1, z))) return false
    return true
  }

  function computeBoatDismountDistance (boat, player) {
    const boatWidth = boat.width
    const playerWidth = player.width
    if (!boatWidth || !playerWidth || boatWidth <= 0 || playerWidth <= 0) return null
    const distance = (boatWidth * Math.SQRT2 + playerWidth) / 2
    return Math.min(distance, MAX_BOAT_DISMOUNT_DISTANCE)
  }

  let pendingPostDismountVehicle = null
  let pendingPostDismountAt = 0

  function clearPendingPostDismount () {
    pendingPostDismountVehicle = null
    pendingPostDismountAt = 0
  }

  function isPendingPostDismountValid () {
    if (pendingPostDismountVehicle == null) return false
    if (Date.now() - pendingPostDismountAt >= POST_DISMOUNT_TIMEOUT_MS) {
      clearPendingPostDismount()
      return false
    }
    return true
  }

  function rememberPendingPostDismount (vehicle) {
    if (vehicle?.name === 'boat' || isRideableHorseEntity(vehicle)) {
      pendingPostDismountVehicle = vehicle
      pendingPostDismountAt = Date.now()
    }
  }

  function applyPostDismountOffset (vehicle) {
    if (vehicle?.name === 'boat') {
      offsetPlayerFromBoat(vehicle)
    } else if (isRideableHorseEntity(vehicle)) {
      offsetPlayerFromHorse(vehicle)
    }
  }

  function offsetPlayerFromBoat (boat) {
    const distance = computeBoatDismountDistance(boat, bot.entity)
    if (distance == null) return

    const y = boat.position.y + (boat.height ?? 0)
    const vehicleVelocity = boat.velocity

    for (const yawOffset of BOAT_DISMOUNT_YAW_OFFSETS) {
      const dirYaw = bot.entity.yaw + yawOffset
      const x = boat.position.x - Math.sin(dirYaw) * distance
      const z = boat.position.z - Math.cos(dirYaw) * distance
      if (!isValidBoatDismountPosition(x, y, z, boat)) continue

      bot.entity.position.set(x, y, z)
      if (vehicleVelocity) {
        bot.entity.velocity.set(vehicleVelocity.x, vehicleVelocity.y, vehicleVelocity.z)
      } else {
        bot.entity.velocity.set(0, 0, 0)
      }
      bot.entity.onGround = false
      return
    }
  }

  function warnMissingBoatCapabilityOnce () {
    if (warnedMissingBoatCapability || boatCapabilityAvailable) return
    warnedMissingBoatCapability = true
    console.warn('[mineflayer] local boat physics unavailable: @nxg-org/mineflayer-physics-util does not export BoatPhysics/BoatState')
  }

  function warnMissingHorseCapabilityOnce () {
    if (warnedMissingHorseCapability || horseCapabilityAvailable) return
    warnedMissingHorseCapability = true
    console.warn('[mineflayer] local horse physics unavailable: @nxg-org/mineflayer-physics-util does not export HorsePhysics/HorseState')
  }

  function isBoatControllerCandidate () {
    return bot.version === BOAT_PHYSICS_VERSION &&
      bot.vehicle?.name === 'boat' &&
      bot.vehicle.passengers?.[0]?.id === bot.entity.id
  }

  function isHorseControllerCandidate () {
    const vehicle = bot.vehicle
    return bot.version === HORSE_PHYSICS_VERSION &&
      vehicle &&
      isRideableHorseEntity(vehicle) &&
      vehicle.passengers?.[0]?.id === bot.entity.id &&
      horseSaddleFlag(vehicle)
  }

  function isHorsePhysicsVersion () {
    return bot.version === HORSE_PHYSICS_VERSION
  }

  function canUseLocalHorsePhysics () {
    return horseCapabilityAvailable && isHorsePhysicsVersion()
  }

  function isHorseController () {
    const vehicle = bot.vehicle
    return canUseLocalHorsePhysics() &&
      vehicle &&
      isRideableHorseEntity(vehicle) &&
      vehicle.passengers?.[0]?.id === bot.entity.id &&
      horseSaddleFlag(vehicle)
  }

  function destroyHorseContext () {
    horseCtx = null
    horseVehicleId = null
    pendingHorseCorrection = null
    pendingHorseJumpRelease = null
    horseTickPacketsReady = false
  }

  function resetHorseCorrectionTracking () {
    horseCorrectionCount = 0
    horseCorrectionWindowStart = 0
    horsePhysicsDisabled = false
    horsePhysicsDisabledLogged = false
  }

  function createHorseContext (vehicle) {
    ensureVehicleRotationDefaults(vehicle)
    const entityType = bot.registry.entitiesByName[vehicle.name] ?? bot.registry.entitiesByName.horse
    const state = HorseState.CREATE_FROM_ENTITY(horsePhysics, vehicle, ControlStateHandler.COPY_BOT(bot))
    horseCtx = EPhysicsCtx.FROM_ENTITY_STATE(horsePhysics, state, entityType)
    horseVehicleId = vehicle.id
    resetHorseCorrectionTracking()
    pendingHorseCorrection = null
    pendingHorseJumpRelease = null
    horseTickPacketsReady = false
  }

  function ensureHorseContext () {
    const vehicle = bot.vehicle
    if (!vehicle || !isRideableHorseEntity(vehicle) || !horseSaddleFlag(vehicle)) {
      destroyHorseContext()
      return false
    }
    if (!horseCtx || horseVehicleId !== vehicle.id) {
      createHorseContext(vehicle)
    }
    return true
  }

  function disableHorsePhysicsWithLog (reason) {
    if (horsePhysicsDisabled) return
    horsePhysicsDisabled = true
    if (!horsePhysicsDisabledLogged) {
      console.warn(`[mineflayer] disabled local horse physics: ${reason}`)
      horsePhysicsDisabledLogged = true
    }
  }

  function applyPendingHorseCorrection () {
    if (!pendingHorseCorrection || !horseCtx || !bot.vehicle) return false
    const correction = pendingHorseCorrection
    pendingHorseCorrection = null

    if (correction.kind === 'entity_velocity') {
      horseCtx.state.vel.set(
        bot.vehicle.velocity.x,
        bot.vehicle.velocity.y,
        bot.vehicle.velocity.z
      )
      return true
    }

    if (correction.kind !== 'vehicle_move') {
      return false
    }

    horseCtx.state.rebaseFromEntity(bot.vehicle, {
      replaceVelocity: correction.replaceVelocity === true
    })
    return true
  }

  function syncControlsToHorseState () {
    if (!horseCtx) return
    horseCtx.state.updateControls(
      ControlStateHandler.COPY_BOT(bot),
      bot.entity.yaw,
      bot.entity.pitch
    )
    horseCtx.state.updateFromHorseEntity(bot.vehicle)
    pendingHorseJumpRelease = horseCtx.state.updateJumpCharge(controlState.jump)
  }

  function isValidHorseDismountPosition (x, y, z, horse) {
    if (!isOutsideHorizontalEntityAabb(x, z, horse)) return false
    const halfWidth = (bot.entity.width ?? 0.6) / 2
    for (const dy of [0, 1]) {
      for (const dx of [-halfWidth, 0, halfWidth]) {
        for (const dz of [-halfWidth, 0, halfWidth]) {
          if (isSolidBlockAt(new Vec3(x + dx, y + dy, z + dz))) return false
        }
      }
    }
    if (isSolidBlockAt(new Vec3(x, y - 0.01, z))) return true
    return isSolidBlockAt(new Vec3(x, y - 1, z))
  }

  function offsetPlayerFromHorse (horse) {
    const playerWidth = bot.entity.width ?? 0.6
    const horseWidth = horse.width ?? 1.3964844
    const distance = (horseWidth + playerWidth) / 2 + 0.2
    const feetY = horse.position.y + getHorsePassengerFeetOffsetY(horse)

    for (const yawOffset of HORSE_DISMOUNT_YAW_OFFSETS) {
      const dirYaw = horse.yaw + yawOffset
      const x = horse.position.x - Math.sin(dirYaw) * distance
      const z = horse.position.z + Math.cos(dirYaw) * distance
      if (!isValidHorseDismountPosition(x, feetY, z, horse)) continue
      bot.entity.position.set(x, feetY, z)
      bot.entity.velocity.set(0, 0, 0)
      bot.entity.onGround = false
      return
    }
  }

  function sendControlledHorsePackets () {
    const vehicle = bot.vehicle
    if (!vehicle || !horseCtx) return false

    ensureVehicleRotationDefaults(vehicle)

    const jumpRelease = pendingHorseJumpRelease
    pendingHorseJumpRelease = null

    if (jumpRelease?.released) {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: 5,
        jumpBoost: jumpRelease.jumpBoost
      })
    }

    const sideways = controlState.left ? 1 : controlState.right ? -1 : 0
    const forward = (controlState.forward ? 1 : 0) - (controlState.back ? 1 : 0)
    bot.moveVehicle(sideways, forward, controlState.jump)

    const x = vehicle.position.x
    const y = vehicle.position.y
    const z = vehicle.position.z
    const yaw = Math.fround(conv.toNotchianYaw(vehicle.yaw))
    const pitch = Math.fround(conv.toNotchianPitch(vehicle.pitch))

    if (![x, y, z, yaw, pitch].every(Number.isFinite)) {
      disableHorsePhysicsWithLog('non-finite vehicle state')
      return false
    }

    bot._client.write('vehicle_move', { x, y, z, yaw, pitch })
    return true
  }

  function isBoatPhysicsVersion () {
    return bot.version === BOAT_PHYSICS_VERSION
  }

  function canUseLocalBoatPhysics () {
    return boatCapabilityAvailable && isBoatPhysicsVersion()
  }

  function isBoatController () {
    return canUseLocalBoatPhysics() &&
      bot.vehicle?.name === 'boat' &&
      bot.vehicle.passengers?.[0]?.id === bot.entity.id
  }

  function needsLegacyBoatPackets () {
    const vehicle = bot.vehicle
    return !canUseLocalBoatPhysics() &&
      vehicle?.name === 'boat' &&
      vehicle.passengers?.[0]?.id === bot.entity.id
  }

  function destroyBoatContext () {
    boatCtx = null
    boatVehicleId = null
    pendingBoatCorrection = null
    boatTickPacketsReady = false
  }

  function resetBoatCorrectionTracking () {
    boatCorrectionCount = 0
    boatCorrectionWindowStart = 0
    boatPhysicsDisabled = false
    boatPhysicsDisabledLogged = false
  }

  function ensureVehicleRotationDefaults (vehicle) {
    if (!Number.isFinite(vehicle.yaw)) vehicle.yaw = 0
    if (!Number.isFinite(vehicle.pitch)) vehicle.pitch = 0
  }

  function createBoatContext (vehicle) {
    ensureVehicleRotationDefaults(vehicle)
    const entityType = bot.registry.entitiesByName.boat
    const state = BoatState.CREATE_FROM_ENTITY(boatPhysics, vehicle, ControlStateHandler.COPY_BOT(bot))
    state.controllingPlayer = true
    boatCtx = EPhysicsCtx.FROM_ENTITY_STATE(boatPhysics, state, entityType)
    boatVehicleId = vehicle.id
    resetBoatCorrectionTracking()
    pendingBoatCorrection = null
    boatTickPacketsReady = false
  }

  function ensureBoatContext () {
    const vehicle = bot.vehicle
    if (!vehicle || vehicle.name !== 'boat') {
      destroyBoatContext()
      return false
    }
    if (!boatCtx || boatVehicleId !== vehicle.id) {
      createBoatContext(vehicle)
    }
    return true
  }

  function disableBoatPhysicsWithLog (reason) {
    if (boatPhysicsDisabled) return
    boatPhysicsDisabled = true
    if (!boatPhysicsDisabledLogged) {
      console.warn(`[mineflayer] disabled local boat physics: ${reason}`)
      boatPhysicsDisabledLogged = true
    }
  }

  function applyPendingBoatCorrection () {
    if (!pendingBoatCorrection || !boatCtx || !bot.vehicle) return false
    const correction = pendingBoatCorrection
    pendingBoatCorrection = null

    if (correction.kind !== 'vehicle_move') {
      if (BOAT_PHYS_DEBUG) {
        console.log(`[boat phys] ignoring correction kind=${correction.kind}`)
      }
      return false
    }

    const vehicle = bot.vehicle
    const localPos = boatCtx.state.pos
    const serverDx = vehicle.position.x - localPos.x
    const serverDy = vehicle.position.y - localPos.y
    const serverDz = vehicle.position.z - localPos.z
    const horizontalDist = Math.sqrt(serverDx * serverDx + serverDz * serverDz)
    const totalDist = Math.sqrt(serverDx * serverDx + serverDy * serverDy + serverDz * serverDz)

    if (BOAT_PHYS_DEBUG) {
      console.log(
        `[boat phys] correction apply kind=${correction.kind} ` +
        `serverDelta=(${serverDx.toFixed(3)},${serverDy.toFixed(3)},${serverDz.toFixed(3)}) ` +
        `horiz=${horizontalDist.toFixed(3)} total=${totalDist.toFixed(3)}`
      )
    }

    boatCtx.state.rebaseFromEntity(vehicle, {
      replaceVelocity: correction.replaceVelocity === true
    })
    return true
  }

  function syncControlsToBoatState () {
    if (!boatCtx) return
    boatCtx.state.controllingPlayer = true
    boatCtx.state.updateControls(ControlStateHandler.COPY_BOT(bot))
  }

  function clampPassengerYawRelativeToBoat () {
    const vehicle = bot.vehicle
    if (!vehicle) return

    let relativeYaw = bot.entity.yaw - vehicle.yaw
    const fullTurn = Math.PI * 2
    relativeYaw = ((relativeYaw + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI
    if (relativeYaw > MAX_BOAT_PASSENGER_YAW_OFFSET) {
      bot.entity.yaw = vehicle.yaw + MAX_BOAT_PASSENGER_YAW_OFFSET
    } else if (relativeYaw < -MAX_BOAT_PASSENGER_YAW_OFFSET) {
      bot.entity.yaw = vehicle.yaw - MAX_BOAT_PASSENGER_YAW_OFFSET
    }
  }

  function sendControlledBoatPackets () {
    const vehicle = bot.vehicle
    if (!vehicle || !boatCtx) return false

    ensureVehicleRotationDefaults(vehicle)

    const x = vehicle.position.x
    const y = vehicle.position.y
    const z = vehicle.position.z
    const yaw = Math.fround(conv.toNotchianYaw(vehicle.yaw))
    const pitch = Math.fround(conv.toNotchianPitch(vehicle.pitch))

    if (![x, y, z, yaw, pitch].every(Number.isFinite)) {
      disableBoatPhysicsWithLog('non-finite vehicle state')
      return false
    }

    const paddles = boatPhysics.getPaddleState(boatCtx.state)
    bot._client.write('steer_boat', paddles)
    bot.moveVehicle(0, 0, false)
    bot._client.write('vehicle_move', { x, y, z, yaw, pitch })
    return true
  }

  bot.on('vehicleCorrection', (entity, correction) => {
    if (!canUseLocalBoatPhysics() || entity.name !== 'boat' || bot.vehicle !== entity) return
    if (!isBoatController()) return

    if (BOAT_PHYS_DEBUG) {
      boatDebugCorrectionCounts[correction.kind] = (boatDebugCorrectionCounts[correction.kind] || 0) + 1
      console.log(
        `[boat phys] correction received kind=${correction.kind} ` +
        `count=${boatDebugCorrectionCounts[correction.kind]}`
      )
    }

    if (correction.kind === 'vehicle_move') {
      const now = performance.now()
      if (now - boatCorrectionWindowStart > BOAT_CORRECTION_WINDOW_MS) {
        boatCorrectionWindowStart = now
        boatCorrectionCount = 0
      }
      boatCorrectionCount++
      if (boatCorrectionCount >= BOAT_CORRECTION_LIMIT) {
        disableBoatPhysicsWithLog(`${BOAT_CORRECTION_LIMIT} server corrections within ${BOAT_CORRECTION_WINDOW_MS}ms`)
      }
    }

    pendingBoatCorrection = correction
  })

  bot.on('vehicleCorrection', (entity, correction) => {
    if (!canUseLocalHorsePhysics() || !isRideableHorseEntity(entity) || bot.vehicle !== entity) return
    if (!isHorseController()) return

    if (correction.kind === 'vehicle_move') {
      const now = performance.now()
      if (now - horseCorrectionWindowStart > HORSE_CORRECTION_WINDOW_MS) {
        horseCorrectionWindowStart = now
        horseCorrectionCount = 0
      }
      horseCorrectionCount++
      if (horseCorrectionCount >= HORSE_CORRECTION_LIMIT) {
        disableHorsePhysicsWithLog(`${HORSE_CORRECTION_LIMIT} server corrections within ${HORSE_CORRECTION_WINDOW_MS}ms`)
      }
    }

    pendingHorseCorrection = correction
  })

  bot.on('mount', () => {
    clearPendingPostDismount()

    const vehicle = bot.vehicle
    if (isBoatControllerCandidate() && !boatCapabilityAvailable) {
      warnMissingBoatCapabilityOnce()
    }
    if (isHorseControllerCandidate() && !horseCapabilityAvailable) {
      warnMissingHorseCapabilityOnce()
    }

    if (isHorsePhysicsVersion() && isRideableHorseEntity(vehicle)) {
      const oldPos = bot.entity.position.clone()
      syncEntityWithHorse()
      if (!bot.entity.position.equals(oldPos)) {
        bot.emit('move', oldPos)
      }
    }

    if (isBoatController()) {
      createBoatContext(bot.vehicle)
    }
    if (isHorseController()) {
      createHorseContext(bot.vehicle)
    }
  })

  bot.on('entityGone', (entity) => {
    if (entity.id === boatVehicleId) {
      destroyBoatContext()
    }
    if (entity.id === horseVehicleId) {
      destroyHorseContext()
    }
  })

  bot.on('dismount', (previousVehicle) => {
    destroyBoatContext()
    destroyHorseContext()
    rememberPendingPostDismount(previousVehicle)
    applyPostDismountOffset(previousVehicle)
  })

  bot.on('entityAttributes', (entity) => {
    if (!horseCtx || bot.vehicle !== entity || horseVehicleId !== entity.id) return
    horseCtx.state.updateFromHorseEntity(entity)
  })

  bot.on('entityMoved', (entity) => {
    if (bot.vehicle !== entity) return
    if (!isServerAuthoritativeMinecart(entity)) return

    const oldPos = bot.entity.position.clone()
    syncEntityWithVehicle()

    if (!bot.entity.position.equals(oldPos)) {
      bot.emit('move', oldPos)
    }
  })

  function tickPhysics (now) {
    const timestep = physicsTimestep
    const onVehicle = bot.vehicle && bot.entity.vehicle
    const boatController = onVehicle && isBoatController()
    const horseController = onVehicle && isHorseController()

    if (boatCtx && !boatController) {
      destroyBoatContext()
    }
    if (horseCtx && !horseController) {
      destroyHorseContext()
    }

    const horsePassengerSync =
      onVehicle &&
      isHorsePhysicsVersion() &&
      isRideableHorseEntity(bot.vehicle)

    if (onVehicle && !boatController) {
      if (horsePassengerSync) {
        syncEntityWithHorse()
      } else {
        syncEntityWithVehicle()
      }
    }

    if (bot.blockAt(bot.entity.position) == null) return

    bot.emit('physicsTickBegin')

    // Vanilla has the current tick's input settled before movement and packet
    // emission. Keep assisted elytra takeoff control in sync with physics so
    // the movement packet matches the input state Grim sees for that tick.
    advanceElytraTakeoffControlBeforePackets()

    if (lastSentYaw === null) lastSentYaw = bot.entity.yaw
    if (lastSentPitch === null) lastSentPitch = bot.entity.pitch

    if (shouldUsePhysics) {
      const dYaw = deltaYawRadians(bot.entity.yaw, lastSentYaw)
      const dPitch = bot.entity.pitch - lastSentPitch

      const maxDeltaYaw = timestep * bot.physicsSettings.yawSpeed
      const maxDeltaPitch = timestep * bot.physicsSettings.pitchSpeed

      lastSentYaw += math.clamp(-maxDeltaYaw, dYaw, maxDeltaYaw)
      lastSentPitch += math.clamp(-maxDeltaPitch, dPitch, maxDeltaPitch)
    }

    boatTickPacketsReady = false
    horseTickPacketsReady = false

    if (bot.physicsEnabled && shouldUsePhysics) {
      if (boatController) {
        if (ensureBoatContext()) {
          const hadPendingCorrection = pendingBoatCorrection != null
          const appliedCorrection = applyPendingBoatCorrection()

          if (!boatPhysicsDisabled) {
            syncControlsToBoatState()
            boatPhysics.simulate(boatCtx, world)
            if (boatCtx.state.worldReady) {
              boatCtx.state.applyToEntity(bot.vehicle)
              boatTickPacketsReady = true
              bot.emit('entityMoved', bot.vehicle)
            }
          }

          if (BOAT_PHYS_DEBUG) {
            const s = boatCtx.state
            console.log(
              `[boat phys] tick status=${s.status} prev=${s.previousStatus} ` +
              `y=${s.pos.y.toFixed(3)} vel=(${s.vel.x.toFixed(4)},${s.vel.y.toFixed(4)},${s.vel.z.toFixed(4)}) ` +
              `water=${s.waterLevel.toFixed(3)} pending=${hadPendingCorrection} applied=${appliedCorrection}`
            )
          }

          syncEntityWithVehicle()
          clampPassengerYawRelativeToBoat()
        }
      } else if (horseController) {
        if (ensureHorseContext()) {
          applyPendingHorseCorrection()

          if (!horsePhysicsDisabled) {
            syncControlsToHorseState()
            horsePhysics.simulate(horseCtx, world)
            if (horseCtx.state.worldReady) {
              horseCtx.state.applyToEntity(bot.vehicle)
              horseTickPacketsReady = true
              bot.emit('entityMoved', bot.vehicle)
            }
          }

          syncEntityWithHorse()
        }
      } else if (!onVehicle) {
        ectx ??= EPhysicsCtx.FROM_BOT(physics, bot, settings)
        ectx.state.update(bot)

        // 2. Sync physics engine to the interpolated look to satisfy anticheats
        ectx.state.yaw = lastSentYaw
        ectx.state.pitch = lastSentPitch

        Object.assign(ectx, settings.overrides)

        // 3. Save target yaw/pitch before applying physics
        const targetYaw = bot.entity.yaw
        const targetPitch = bot.entity.pitch

        physics.simulate(ectx, world).apply(bot)

        // 4. Restore target yaw/pitch so the bot doesn't forget where it's trying to look
        bot.entity.yaw = targetYaw
        bot.entity.pitch = targetPitch
      }

      bot.emit('entityPhysicsTick')
    }

    if (shouldUsePhysics) updatePosition(now)

    // move this afterward to sync inputs.
    if (bot.physicsEnabled && shouldUsePhysics) {
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }

    if (bot.registry.isNewerOrEqualTo('1.21.3')) {
      bot._client.write('tick_end', {})
    }
  }

  bot.on('newListener', (name) => {
    if (name === 'physicTick') {
      console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use physicsTick instead.')
    }
  })

  function cleanup () {
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = null
  }

  function sendPacketPosition (position, onGround, hasHorizontalCollision) {
    // Don't send position packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    // console.log(`sendPacketPosition: position=${position.toString()} onGround=${onGround} hasHorizontalCollision=${hasHorizontalCollision}`)

    // sends data, no logic
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision }
    bot._client.write('position', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketLook (yaw, pitch, onGround, hasHorizontalCollision) {
    // Don't send look packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    // sends data, no logic
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision }
    bot._client.write('look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketPositionAndLook (position, yaw, pitch, onGround, hasHorizontalCollision) {
    // Don't send position_look packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    // console.log(`sendPacketPositionAndLook: position=${position.toString()} yaw=${yaw} pitch=${pitch} onGround=${onGround} hasHorizontalCollision=${hasHorizontalCollision}`)
    // sends data, no logic
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision }
    bot._client.write('position_look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketSteerVehicle () {
    bot.vehicleMove ??= {
      forward: bot.controlState.forward ? 1 : bot.controlState.back ? -1 : 0,
      sideways: bot.controlState.left ? 1 : bot.controlState.right ? -1 : 0,
      jump: bot.controlState.jump ? 1 : 0
    }

    for (const key of Object.keys(bot.vehicleMove)) {
      bot.vehicleMove[key] = Math.min(Math.abs(bot.vehicleMove[key]), MAX_VEHICLE_MOVE_COMPONENT) * Math.sign(bot.vehicleMove[key])
    }

    bot.moveVehicle(bot.vehicleMove.sideways, bot.vehicleMove.forward, bot.vehicleMove.jump)

    bot.vehicleMove = {
      sideways: 0,
      forward: 0,
      jump: 0
    }
  }

  function sendPacketVehicleMove () {
    sendPacketSteerVehicle()

    const vehicle = bot.vehicle
    const x = vehicle.position.x
    const y = vehicle.position.y
    const z = vehicle.position.z
    const yaw = Math.fround(conv.toNotchianYaw(vehicle.yaw))
    const pitch = Math.fround(conv.toNotchianPitch(vehicle.pitch))
    if (![x, y, z, yaw, pitch].every(Number.isFinite)) return

    bot._client.write('vehicle_move', { x, y, z, yaw, pitch })
  }

  function isEntityRemoved () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    return deadTicks >= 20
  }

  function updatePosition (now) {
    if (isEntityRemoved()) return
    // Don't send position with invalid coordinates (NaN after death)
    if (!Number.isFinite(bot.entity.position.x)) return

    // Don't send any position packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    const forward = (controlState.forward ? 1 : 0) - (controlState.back ? 1 : 0)
    const isSprintingApplicable = forward > 0 && !controlState.sneak && !bot.entity.isInWater && !bot.entity.isInLava
    const fallbackSprint = isSprintingApplicable && controlState.sprint
    const resolvedSprint = ectx?.state?.sprinting ?? bot.entity.sprinting
    const actualSprint = typeof resolvedSprint === 'boolean' ? resolvedSprint : fallbackSprint
    const isJumpRisingEdge = controlState.jump && !lastSent.previousInputState.jump

    // Vanilla starts fall-flying during aiStep(), before the packet send phase
    // for shift/input/sprint/movement. Grim's Post check also expects the
    // elytra entity_action not to trail behind a movement packet.
    tryStartPendingElytraFly(isJumpRisingEdge)

    if (lastSent.sneakState !== controlState.sneak) {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (controlState.sneak ? 'start_sneaking' : 'stop_sneaking')
          : (controlState.sneak ? 0 : 1),
        jumpBoost: 0
      })
      lastSent.sneakState = controlState.sneak
    }

    if (bot.supportFeature('newPlayerInputPacket') &&
        !checkInputEquality(lastSent.previousInputState, controlState)) {
      lastSent.previousInputState = cloneInput(controlState)
      bot._client.write('player_input', {
        inputs: {
          forward: controlState.forward,
          backward: controlState.back,
          left: controlState.left,
          right: controlState.right,
          jump: controlState.jump,
          shift: controlState.sneak,
          sprint: controlState.sprint
        }
      })
    }

    if (lastSent.sprintState !== actualSprint) {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (actualSprint ? 'start_sprinting' : 'stop_sprinting')
          : (actualSprint ? 3 : 4),
        jumpBoost: 0
      })
      lastSent.sprintState = actualSprint
    }

    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw))
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch))
    const position = bot.entity.position
    const onGround = bot.entity.onGround
    const hasHorizontalCollision = getHorizontalCollision()

    const dx = position.x - lastSent.x
    const dy = position.y - lastSent.y
    const dz = position.z - lastSent.z
    const positionUpdated =
      (dx * dx + dy * dy + dz * dz > MIN_DELTA_DIST_SQUARED) ||
      lastSent.ticker === 0

    const lookUpdated = lastUpdated.yaw !== yaw || lastUpdated.pitch !== pitch

    const onVehicle = !!bot.entity.vehicle
    const onBoat = bot.vehicle?.name === 'boat'
    const boatController = onVehicle && isBoatController()
    const horseController = onVehicle && isHorseController()
    if (needsLegacyBoatPackets()) {
      bot._client.write('steer_boat', {
        leftPaddle: bot.controlState.left || bot.controlState.forward || bot.controlState.back,
        rightPaddle: bot.controlState.right || bot.controlState.forward || bot.controlState.back
      })
    }

    let sendLook = false
    if (onVehicle) {
      sendLook = true
    } else if (positionUpdated && lookUpdated) {
      sendPacketPositionAndLook(position, yaw, pitch, onGround, hasHorizontalCollision)
      lastSent.ticker = POSITION_EVERY_N_TICKS
    } else if (positionUpdated) {
      sendPacketPosition(position, onGround, hasHorizontalCollision)
      lastSent.ticker = POSITION_EVERY_N_TICKS
    } else if (lookUpdated) {
      sendLook = true
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround || hasHorizontalCollision !== lastSent.flags.hasHorizontalCollision) {
      bot._client.write('flying', {
        flags: { onGround, hasHorizontalCollision }
      })
      lastSent.flags = { onGround, hasHorizontalCollision }
    }

    if (sendLook) {
      sendPacketLook(yaw, pitch, onGround, hasHorizontalCollision)
    }

    if (onVehicle) {
      if (boatController) {
        if (boatTickPacketsReady) {
          sendControlledBoatPackets()
        }
      } else if (horseController) {
        if (horseTickPacketsReady) {
          sendControlledHorsePackets()
        }
      } else if (isServerAuthoritativeMinecart(bot.vehicle)) {
        sendPacketSteerVehicle()
      } else if (!canUseLocalBoatPhysics() || !onBoat) {
        sendPacketVehicleMove()
      }
    }

    if (lookUpdated) {
      lastUpdated.yaw = yaw
      lastUpdated.pitch = pitch
    }

    if (!positionUpdated) {
      lastSent.ticker -= 1
    }

    lastSent.onGround = bot.entity.onGround
    advanceElytraTakeoffControlAfterPackets()
    bot.physicsEngineCtx = ectx
  }

  bot.physicsEngine = physics
  bot.physicsSettings = settings
  bot.physicsCtx = ectx

  const obj = {}
  Object.keys(bot.physicsEngine).forEach((key) => {
    Object.defineProperty(obj, key, {
      get () {
        return bot.physicsEngine[key]
      },
      set (value) {
        bot.physicsEngine[key] = value
        return value
      }
    })
  })

  Object.keys(bot.physicsSettings).forEach((key) => {
    Object.defineProperty(obj, key, {
      get () {
        return bot.physicsSettings[key]
      },
      set (value) {
        bot.physicsSettings[key] = value
        return value
      }
    })
  })

  Object.defineProperty(obj, 'physicsIntervalMs', {
    enumerable: true,
    get () {
      return physicsIntervalMs
    },
    set (value) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError('physics.physicsIntervalMs must be a finite number greater than 0')
      }
      physicsIntervalMs = value
      physicsTimestep = value / 1000
      restartPhysicsTimer()
      return value
    }
  })

  obj.simulatePlayer = function (oldState, world) {
    const eType = bot.registry.entitiesByName.player ?? bot.registry.entitiesByName['minecraft:player']

    // for versions 1.9 and below, this doesn't exist.
    // I provide a default if this value is undefined, so this is fine either way.
    // if (!eType) throw new Error('Player entity type not found in registry')

    const state = convertPlayerState(bot, oldState, physics)

    const ectx = EPhysicsCtx.FROM_ENTITY_STATE(
      physics,
      state,
      eType,
      settings
    )

    Object.assign(ectx, settings.overrides)

    physics.simulate(ectx, world)
    applyToPlayerState(state, oldState)
  }

  bot.physics = obj
  bot.physicsWorld = world

  function getEffectLevel (mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName]
    if (!effectDescriptor) return 0
    const effectInfo = effects[effectDescriptor.id]
    if (!effectInfo) return 0
    return effectInfo.amplifier + 1
  }

  function getElytraFlyPreflightError () {
    if (bot.entity.fallFlying) {
      return 'Already elytra flying'
    } else if (bot.entity.onClimbable) {
      return 'Unable to elytra fly while on climbable'
    } else if (bot.entity.vehicle) {
      return 'Unable to elytra fly while in vehicle'
    } else if (bot.entity.isInWater) {
      return 'Unable to elytra fly while in water'
    }

    const mcData = require('minecraft-data')(bot.version)
    if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
      return 'Unable to elytra fly with levitation effect'
    }

    const torsoSlot = bot.getEquipmentDestSlot('torso')
    const item = bot.inventory.slots[torsoSlot]
    if (item == null || item.name !== 'elytra') {
      return 'Elytra must be equip to start flying'
    }

    return null
  }

  function getPendingElytraFlyPreflightError (force = false) {
    const preflightError = getElytraFlyPreflightError()
    if (force && preflightError === 'Already elytra flying') return null
    if (preflightError !== 'Already elytra flying') return preflightError

    // The local physics engine can flip fallFlying on the same rising-edge jump
    // that should also emit START_FLYING_WITH_ELYTRA. Treat that as the vanilla
    // local-state transition for this pending request rather than rejecting our
    // own packet before it is written.
    if (pendingElytraFly && !speculativeElytraFly && bot.entity._pendingElytraFlightConfirmation !== true) {
      return null
    }

    return preflightError
  }

  function tryStartPendingElytraFly (isJumpRisingEdge) {
    if (!pendingElytraFly || elytraFlyTask.done) return

    const preflightError = getPendingElytraFlyPreflightError(forceElytraFly)
    if (preflightError != null) {
      clearPendingElytraFly(new Error(preflightError))
      return
    }

    if (!forceElytraFly) {
      if (bot.entity.onGround || lastSent.onGround) return
      if (!isJumpRisingEdge) return
    }

    // Intentional deviation from vanilla: vanilla only emits
    // START_FLYING_WITH_ELYTRA after the off-ground jump transition in
    // LocalPlayer/LivingEntity. The documented mineflayer force option is used
    // here to bypass that packet-send gate as well, so a forced rebounce sends
    // the packet immediately instead of waiting for a new airborne jump edge.
    // This is specifically for anticheat experimentation where preserving
    // continuous local fall-flying state is preferred over vanilla timing.

    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
      jumpBoost: 0
    })
    if (resolveForcedElytraFlyImmediately) {
      clearPendingElytraFly()
      return
    }

    setLocalElytraFlyState(true)
    speculativeElytraFly = true
    pendingElytraFly = false
    forceElytraFly = false
    setPendingElytraFlyRequestState(false)
  }

  function setLocalElytraFlyState (enabled) {
    bot.entity.elytraFlying = enabled
    bot.entity.fallFlying = enabled
    bot.entity._pendingElytraFlightConfirmation = enabled

    if (ectx?.state != null) {
      if ('elytraFlying' in ectx.state) ectx.state.elytraFlying = enabled
      if ('fallFlying' in ectx.state) ectx.state.fallFlying = enabled
    }
  }

  function clearPendingElytraFly (err) {
    clearElytraTakeoffControl()

    pendingElytraFly = false
    forceElytraFly = false
    resolveForcedElytraFlyImmediately = false
    setPendingElytraFlyRequestState(false)
    if (elytraFlyTimeout != null) {
      clearTimeout(elytraFlyTimeout)
      elytraFlyTimeout = null
    }

    if (err != null && speculativeElytraFly) {
      setLocalElytraFlyState(false)
    }
    speculativeElytraFly = false

    if (err != null) {
      elytraFlyTask.cancel(err)
    } else {
      elytraFlyTask.finish()
    }

    elytraFlyTask = createDoneTask()
  }

  function armPendingElytraFlyTimeout (assistTakeoff) {
    if (elytraFlyTimeout != null) {
      clearTimeout(elytraFlyTimeout)
    }

    elytraFlyTimeout = setTimeout(() => {
      clearPendingElytraFly(new Error('Timed out waiting for elytra flight to start'))
    }, assistTakeoff ? 2500 : 1500)
  }

  bot.elytraFly = async (options = {}) => {
    const normalizedOptions = typeof options === 'boolean' ? { assistTakeoff: options } : options
    const {
      assistTakeoff = false,
      force = false
    } = normalizedOptions

    if (!elytraFlyTask.done) {
      // Vanilla re-evaluates jump/input state each tick before movement and
      // packet emission; see LocalPlayer.tick()/serverAiStep() and
      // LivingEntity.travel() in the 1.21.4 client. If a previous mineflayer
      // elytra request is still pending, let a forced retry refresh that
      // pending controller instead of coalescing it away until timeout.
      // Anticheat expects a renewed grounded takeoff sequence to emit the
      // matching START_FLYING_WITH_ELYTRA packet rather than preserving a
      // stale pending request with outdated jump state.
      if (force && pendingElytraFly) {
        const preflightError = getElytraFlyPreflightError()
        if (preflightError != null && preflightError !== 'Already elytra flying') {
          clearPendingElytraFly(new Error(preflightError))
        } else {
          forceElytraFly = true
          resolveForcedElytraFlyImmediately = preflightError === 'Already elytra flying'
          clearElytraTakeoffControl()
          startElytraTakeoffControl(assistTakeoff)
          setPendingElytraFlyRequestState(true)
          armPendingElytraFlyTimeout(assistTakeoff)
        }
      }

      return await elytraFlyTask.promise
    }

    const preflightError = getElytraFlyPreflightError()
    if (preflightError != null && !(force && preflightError === 'Already elytra flying')) {
      throw new Error(preflightError)
    }

    elytraFlyTask = createTask()
    pendingElytraFly = true
    forceElytraFly = force
    resolveForcedElytraFlyImmediately = force && preflightError === 'Already elytra flying'
    setPendingElytraFlyRequestState(true)
    startElytraTakeoffControl(assistTakeoff)
    armPendingElytraFlyTimeout(assistTakeoff)

    return await elytraFlyTask.promise
  }

  bot.spoofControlState = (control, state) => {
    controlState[control] = state
  }

  bot.setControlState = (control, state) => {
    if (control === 'sneak' && state === true && bot.vehicle) {
      bot.dismount()
      return
    }

    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (control === 'jump' && isElytraTakeoffControlActive()) return
    if (controlState[control] === state) return

    controlState[control] = state
    if (control === 'jump' && state) {
      bot.jumpQueued = true
    }
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  bot.controlState = {}
  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get () {
        return controlState[control]
      },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  let lookingTask = createDoneTask()
  let targetYaw = null
  let targetPitch = null

  bot.on('physicsTick', () => {
    if (lookingTask.done || targetYaw == null || targetPitch == null) return

    const currentYawDeg = new JavaFloat(conv.toNotchianYaw(bot.entity.yaw))
    const currentPitchDeg = new JavaFloat(conv.toNotchianPitch(bot.entity.pitch))

    const deltaYaw = deltaYawDegrees(targetYaw, currentYawDeg).valueOf()
    const deltaPitch = targetPitch.subtract(currentPitchDeg).valueOf()

    if (Math.abs(deltaYaw) < 0.1 && Math.abs(deltaPitch) < 0.1) {
      lookingTask.finish()
      return
    }

    const yawChange = math.clamp(-bot.physicsSettings.yawSpeed / 20, deltaYaw, bot.physicsSettings.yawSpeed / 20)
    const pitchChange = math.clamp(-bot.physicsSettings.pitchSpeed / 20, deltaPitch, bot.physicsSettings.pitchSpeed / 20)

    setAngleDegrees(
      bot,
      currentYawDeg.valueOf() + yawChange,
      currentPitchDeg.valueOf() + pitchChange,
      true
    )
  })

  bot._client.on('explosion', explosion => {
    if (bot.physicsEnabled && bot.game.gameMode !== 'creative') {
      if (explosion.playerKnockback) {
        bot.entity.velocity.x += explosion.playerKnockback.x
        bot.entity.velocity.y += explosion.playerKnockback.y
        bot.entity.velocity.z += explosion.playerKnockback.z
      }
      if ('playerMotionX' in explosion) {
        bot.entity.velocity.x += explosion.playerMotionX
        bot.entity.velocity.y += explosion.playerMotionY
        bot.entity.velocity.z += explosion.playerMotionZ
      }
    }
  })

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) {
      lookingTask.finish()
      targetYaw = null
      targetPitch = null
    }

    const yawNotchian = conv.toNotchianYaw(yaw)
    const pitchNotchian = conv.toNotchianPitch(pitch)

    if (force) {
      setAngleDegrees(bot, yawNotchian, pitchNotchian, true)
      lastSentYaw = bot.entity.yaw
      lastSentPitch = bot.entity.pitch
      return
    }

    lookingTask = createTask()
    targetYaw = new JavaFloat(yawNotchian)
    targetPitch = new JavaFloat(pitchNotchian)
    return await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  bot._client.on('player_rotation', (packet) => {
    setAngleDegrees(bot, packet.yaw, packet.pitch, false)
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch
  })

  // player position and look (clientbound)
  bot._client.on('position', (packet) => {
    const shouldReapplyPostDismountOffset = packet.dismountVehicle === true

    if (packet.dismountVehicle === true && bot.vehicle) {
      const previousVehicle = bot.vehicle
      bot.vehicle = null
      delete bot.entity.vehicle
      destroyBoatContext()
      destroyHorseContext()
      bot.emit('dismount', previousVehicle)
    }

    bot.entity.height = 1.8

    const vel = bot.entity.velocity
    const pos = bot.entity.position
    let newYaw, newPitch

    if (typeof packet.flags === 'object') {
      vel.set(
        packet.flags.x ? vel.x : 0,
        packet.flags.y ? vel.y : 0,
        packet.flags.z ? vel.z : 0
      )
      pos.set(
        packet.flags.x ? (pos.x + packet.x) : packet.x,
        packet.flags.y ? (pos.y + packet.y) : packet.y,
        packet.flags.z ? (pos.z + packet.z) : packet.z
      )

      const currentYaw = typeof bot.entity.yawDegrees !== 'undefined'
        ? bot.entity.yawDegrees.valueOf()
        : conv.toNotchianYaw(bot.entity.yaw)
      const currentPitch = typeof bot.entity.pitchDegrees !== 'undefined'
        ? bot.entity.pitchDegrees.valueOf()
        : conv.toNotchianPitch(bot.entity.pitch)

      newYaw = (packet.flags.yaw ? currentYaw : 0) + packet.yaw
      newPitch = (packet.flags.pitch ? currentPitch : 0) + packet.pitch
    } else {
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0
      )
      pos.set(
        packet.flags & 1 ? (pos.x + packet.x) : packet.x,
        packet.flags & 2 ? (pos.y + packet.y) : packet.y,
        packet.flags & 4 ? (pos.z + packet.z) : packet.z
      )

      const currentYaw = typeof bot.entity.yawDegrees !== 'undefined'
        ? bot.entity.yawDegrees.valueOf()
        : conv.toNotchianYaw(bot.entity.yaw)
      const currentPitch = typeof bot.entity.pitchDegrees !== 'undefined'
        ? bot.entity.pitchDegrees.valueOf()
        : conv.toNotchianPitch(bot.entity.pitch)

      newYaw = (packet.flags & 8 ? currentYaw : 0) + packet.yaw
      newPitch = (packet.flags & 16 ? currentPitch : 0) + packet.pitch
    }

    setAngleDegrees(bot, newYaw, newPitch, false)
    bot.entity.onGround = false

    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })
    }

    // After death/respawn, delay the forced position_look response.
    // Sending it immediately causes "Invalid move player packet" kicks
    // on older servers, but the server needs it to complete the respawn.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      const delayedPos = pos.clone()
      const delayedYaw = newYaw
      const delayedPitch = newPitch
      const delayedOnGround = bot.entity.onGround
      setTimeout(() => {
        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
        shouldUsePhysics = true
        bot.jumpTicks = 0
        lastSentYaw = bot.entity.yaw
        lastSentPitch = bot.entity.pitch
        bot.emit('forcedMove')
      }, 1500)
      return
    }

    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)

    if (shouldReapplyPostDismountOffset && bot.vehicle == null && isPendingPostDismountValid()) {
      const vehicle = pendingPostDismountVehicle
      const packetStillOnBoat = vehicle?.name === 'boat' &&
        !isOutsideHorizontalEntityAabb(pos.x, pos.z, vehicle)
      if (packetStillOnBoat) {
        applyPostDismountOffset(vehicle)
      }
    }

    shouldUsePhysics = true
    bot.jumpTicks = 0
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch

    bot.emit('forcedMove')
  })

  bot.on('entityElytraState', (entity, elytraFlying) => {
    if (entity.id !== bot.entity?.id || elytraFlyTask.done) return
    if (elytraFlying) {
      clearPendingElytraFly()
    }
  })

  bot.waitForTicks = async function (ticks, tickBegin = false) {
    if (ticks <= 0) return
    const eventName = tickBegin ? 'physicsTickBegin' : 'physicsTick'
    await new Promise((resolve) => {
      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          bot.removeListener(eventName, tickListener)
          resolve()
        }
      }

      bot.on(eventName, tickListener)
    })
  }

  let respawnTimer = 0
  bot.on('mount', () => {
    if (
      isBoatController() ||
      isHorseController() ||
      needsLegacyBoatPackets() ||
      isServerAuthoritativeMinecart(bot.vehicle)
    ) {
      shouldUsePhysics = true
    } else {
      shouldUsePhysics = false
    }
  })
  bot.on('death', () => {
    shouldUsePhysics = false
    destroyBoatContext()
    destroyHorseContext()
    respawnTimer = Date.now()
  })
  bot.on('respawn', () => {
    shouldUsePhysics = false
    destroyBoatContext()
    destroyHorseContext()
  })
  bot.on('login', () => {
    shouldUsePhysics = false
    destroyBoatContext()
    destroyHorseContext()
  })

  function forceResetControls () {
    elytraTakeoffControl = null
    setPendingElytraFlyRequestState(false)
    for (const control in controlState) {
      controlState[control] = false
    }
  }

  bot.on('respawn', () => {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
    shouldUsePhysics = false
    forceResetControls()
    clearPendingElytraFly(new Error('Elytra flight cancelled due to respawn'))
  })

  bot.on('login', () => {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
    shouldUsePhysics = false
    forceResetControls()
    bot.entity._pendingElytraFlightConfirmation = false

    lastSent = {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      onGround: false,
      ticker: POSITION_EVERY_N_TICKS,
      flags: { onGround: false, hasHorizontalCollision: false },
      sprintState: false,
      sneakState: false,
      previousInputState: cloneInput(controlState)
    }

    bot._lastSent = lastSent
    lastSentYaw = null
    lastSentPitch = null
    lastUpdated.yaw = 0
    lastUpdated.pitch = 0
    clearPendingElytraFly(new Error('Elytra flight cancelled due to login'))

    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      doPhysicsTimer = setInterval(doPhysics, physicsIntervalMs)
    }
  })

  bot.on('end', () => {
    clearPendingElytraFly(new Error('Elytra flight cancelled due to disconnect'))
    cleanup()
  })

  bot._boatPhysics = {
    getCtx () { return boatCtx },
    isDisabled () { return boatPhysicsDisabled },
    getStatus () { return boatCtx?.state?.status ?? null },
    getPaddleState () {
      return boatCtx && boatPhysics ? boatPhysics.getPaddleState(boatCtx.state) : null
    }
  }

  bot._horsePhysics = {
    getCtx () { return horseCtx },
    isDisabled () { return horsePhysicsDisabled }
  }
}

module.exports = inject
