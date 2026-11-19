import type { ModelFailureKind } from '@agent-learning/model'

export const retryReasons = {
  connection: 'retry.connectionWait',
  'connection-reset': 'retry.connectionReset',
  'stream-read': 'retry.streamRead',
  'stream-ended': 'retry.streamEnded',
  timeout: 'retry.timeout',
  'temporary-rate-limit': 'retry.temporaryRateLimit',
  'rate-limit': 'retry.rateLimit',
  internal: 'retry.internal',
  'bad-gateway': 'retry.badGateway',
  unavailable: 'retry.unavailable',
  'gateway-timeout': 'retry.gatewayTimeout',
  overloaded: 'retry.overloaded',
  capacity: 'retry.capacity',
  'request-error': 'retry.requestError',
  'response-error': 'retry.responseError',
  'http-error': 'retry.httpError',
  balance: 'retry.balance',
  quota: 'retry.quota',
  authentication: 'retry.authentication',
  permission: 'retry.permission',
  'invalid-request': 'retry.invalidRequest',
  configuration: 'retry.configuration',
  'context-capacity': 'retry.contextCapacity',
  unknown: 'retry.unknown',
} as const satisfies Record<ModelFailureKind, string>

export const needsServerDeadline = new Set<ModelFailureKind>(['rate-limit', 'overloaded', 'capacity'])
export const terminalOnly = new Set<ModelFailureKind>([
  'balance', 'quota', 'authentication', 'permission', 'invalid-request', 'configuration', 'context-capacity', 'unknown',
])
