'use strict'

function hasTransportPhysicsCapability (PhysicsCtor, StateCtor) {
  return typeof PhysicsCtor === 'function' &&
    StateCtor != null &&
    typeof StateCtor.CREATE_FROM_ENTITY === 'function'
}

function resolveTransportPhysicsCapabilities (physicsUtil) {
  return {
    boat: hasTransportPhysicsCapability(physicsUtil.BoatPhysics, physicsUtil.BoatState),
    horse: hasTransportPhysicsCapability(physicsUtil.HorsePhysics, physicsUtil.HorseState)
  }
}

module.exports = {
  hasTransportPhysicsCapability,
  resolveTransportPhysicsCapabilities
}
