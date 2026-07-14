const {
  EntityPhysics,
  EPhysicsCtx,
  EntityState,
  PhysicsWorldSettings
} = require('@nxg-org/mineflayer-physics-util')

const RIDEABLE_HORSE_ENTITY_NAMES = new Set([
  'horse',
  'donkey',
  'mule',
  'skeleton_horse',
  'zombie_horse'
])

function isRideableHorseEntityName (name) {
  return name != null && RIDEABLE_HORSE_ENTITY_NAMES.has(name)
}

module.exports = inject
module.exports.isRideableHorseEntityName = isRideableHorseEntityName

function inject (bot) {
  const physics = new EntityPhysics(bot.registry)
  const settings = bot.physicsSettings ?? new PhysicsWorldSettings(bot.registry)
  const contexts = new Map()

  bot.entityPhysics = {
    contexts,
    settings,
    syncEntity,
    simulateEntity,
    clear: clearContexts
  }

  bot.on('entitySpawn', syncEntity)
  bot.on('entityMoved', syncEntity)
  bot.on('entityVelocity', syncEntity)
  bot.on('entityUpdate', syncEntity)
  bot.on('entityEquip', syncEntity)
  bot.on('entityEffect', syncEntity)
  bot.on('entityEffectEnd', syncEntity)
  bot.on('entityCrouch', syncEntity)
  bot.on('entityUncrouch', syncEntity)

  bot.on('entityGone', (entity) => {
    if (entity?.id != null) contexts.delete(entity.id)
  })

  bot.on('worldSwitch', clearContexts)

  bot.on('entityPhysicsTick', () => {
    for (const entity of Object.values(bot.entities)) {
      simulateEntity(entity)
    }
  })

  function clearContexts () {
    contexts.clear()
  }

  function resolveEntityType (entity) {
    return bot.registry.entities[entity.entityType] ??
      bot.registry.entitiesByName[entity.name] ??
      bot.registry.entitiesByName[`minecraft:${entity.name}`] ??
      null
  }

  function canSimulateEntity (entity) {
    if (!entity || entity === bot.entity || entity.isValid === false) return false
    if (!entity.position || !entity.velocity) return false
    if (typeof entity.height !== 'number' || typeof entity.width !== 'number') return false
    if (entity.type === 'player') return false
    if (bot.version === '1.17.1') {
      if (isRideableHorseEntityName(entity.name)) {
        return false
      }
      if (
        bot.vehicle === entity &&
        entity.passengers?.[0]?.id === bot.entity.id &&
        entity.name === 'boat'
      ) {
        return false
      }
    }
    return resolveEntityType(entity) != null
  }

  function syncEntity (entity) {
    if (!canSimulateEntity(entity)) {
      if (entity?.id != null) contexts.delete(entity.id)
      return null
    }

    const entityType = resolveEntityType(entity)
    let ctx = contexts.get(entity.id)

    if (ctx == null || ctx.entityType !== entityType) {
      const state = EntityState.CREATE_FROM_ENTITY(physics, entity)
      ctx = EPhysicsCtx.FROM_ENTITY_STATE(physics, state, entityType, settings)
      contexts.set(entity.id, ctx)
      return ctx
    }

    ctx.state.updateFromEntity(entity, true)
    ctx.pose = ctx.state.pose

    return ctx
  }

  function simulateEntity (entity) {
    if (!canSimulateEntity(entity)) return null

    const ctx = contexts.get(entity.id)
    if (ctx == null) return null

    if (bot.blockAt(ctx.state.pos) == null) return null

    Object.assign(ctx, settings.overrides)

    physics.simulate(ctx, bot.physicsWorld)
    ctx.state.applyToEntity(entity)
    return ctx.state
  }
}
