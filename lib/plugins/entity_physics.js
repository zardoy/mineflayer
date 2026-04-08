const {
  EntityPhysics,
  EPhysicsCtx,
  EntityState,
  PhysicsWorldSettings
} = require('@nxg-org/mineflayer-physics-util')

module.exports = inject

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
  bot.on('entityUpdate', syncEntity)
  bot.on('entityEquip', syncEntity)
  bot.on('entityEffect', syncEntity)
  bot.on('entityEffectEnd', syncEntity)
  bot.on('entityCrouch', syncEntity)
  bot.on('entityUncrouch', syncEntity)
  bot.on('entityGone', (entity) => {
    contexts.delete(entity.id)
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
    return resolveEntityType(entity) != null
  }

  /**
   * 
   * @param {import('prismarine-entity').Entity} entity 
   * @param {*} ctx 
   */
  function setPredictedState (entity, ctx) {
    entity.position.set(ctx.position.x, ctx.position.y, ctx.position.z)
    entity.velocity.set(ctx.velocity.x, ctx.velocity.y, ctx.velocity.z)
    entity.onGround = ctx.state.onGround
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
    } else {
      ctx.state.updateFromEntity(entity, true)
    }

    ctx.pose = ctx.state.pose
    setPredictedState(entity, ctx)
    return ctx
  }

  function simulateEntity (entity) {
    const ctx = contexts.get(entity.id) ?? syncEntity(entity)
    if (ctx == null) return null
    if (bot.blockAt(ctx.position) == null) return null

    Object.assign(ctx, settings.overrides)
    physics.simulate(ctx, bot.physicsWorld)
    setPredictedState(entity, ctx)
    return ctx.state
  }
}
