import type { ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const validators = new Map<string, ValidateFunction>()

export function signalValidator(serialized: string): ValidateFunction {
  const cached = validators.get(serialized)
  if (cached) return cached

  // Each document owns its references, including when two versions use the same $id.
  const ajv = addFormats(new Ajv2020({ strictTypes: false, strictTuples: false, ownProperties: true }))
  const schema = JSON.parse(serialized)
  if (schema?.$async === true) throw new TypeError('Workflow signal schemas must be synchronous.')
  const validator = ajv.compile(schema)
  if (validators.size >= 64) validators.delete(validators.keys().next().value!)
  validators.set(serialized, validator)
  return validator
}
