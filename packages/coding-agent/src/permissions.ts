export type PermissionMode = 'normal' | 'read-only'

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'normal' || value === 'read-only'
}
