import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

const options = { strict: false, addUsedSchema: false, validateFormats: false, ownProperties: true }
const draft7 = new Ajv(options)
const draft2019 = new Ajv2019(options)
const draft2020 = new Ajv2020(options)
const validators = new WeakMap<Record<string, unknown>, ValidateFunction | null>()

export function validateMcpArguments(schema: Record<string, unknown>, args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  try {
    let validate = validators.get(schema)
    if (validate === undefined) {
      const metaSchema = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : schema.$schema
      const ajv = metaSchema === 'http://json-schema.org/draft-07/schema' ? draft7
        : metaSchema === 'https://json-schema.org/draft/2019-09/schema' ? draft2019 : draft2020
      // Synchronous compilation keeps remote references out of the request path.
      try {
        const compiled = ajv.compile(schema)
        validate = '$async' in compiled ? null : compiled
        validators.set(schema, validate)
      } finally {
        // Ajv's strong cache must not retain old tool catalogs after a reconnect.
        ajv.removeSchema()
      }
    }
    return validate?.(args) === true
  } catch {
    validators.set(schema, null)
    return false
  }
}
