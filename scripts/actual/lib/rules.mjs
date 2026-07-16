import yaml from 'js-yaml'

/**
 * Load and validate the T0 payee-rules document (spec §4).
 *
 * A missing or malformed file must ABORT the run (§4.3) — never silently
 * degrade to "categorize everything as General" on a run that still reports
 * success. That combination is exactly what hid the gas-therms bug for months
 * (#275). So every validation failure throws.
 *
 * Ordered — first match wins; exclusions are evaluated before rules (see
 * classify.mjs). Match substrings and exclusions are lowercased here so a
 * non-lowercase rule still works (matching lowercases the payee).
 *
 * @param {string} yamlText raw YAML
 * @returns {{ exclude_transfer: string[], exclude_investment: string[], rules: Array<{category: string, match: string[]}> }}
 */
export function loadRules(yamlText) {
  let doc
  try {
    doc = yaml.load(yamlText)
  } catch (err) {
    throw new Error(`payee rules file is not valid YAML: ${err.message}`)
  }

  if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('payee rules file must be a YAML mapping with a `rules` list')
  }

  if (!Array.isArray(doc.rules)) {
    throw new Error('payee rules file must contain a `rules` list')
  }

  const rules = doc.rules.map((rule, i) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`rules[${i}] must be a mapping with "category" and "match"`)
    }
    if (typeof rule.category !== 'string' || rule.category.trim() === '') {
      throw new Error(`rules[${i}] is missing a non-empty "category"`)
    }
    if (!Array.isArray(rule.match) || rule.match.length === 0) {
      throw new Error(`rules[${i}] ("${rule.category}") needs a non-empty "match" list`)
    }
    return {
      category: rule.category,
      match: rule.match.map((m) => normalizeKey(m, `rules[${i}].match`)),
    }
  })

  return {
    exclude_transfer: normalizeList(doc.exclude_transfer, 'exclude_transfer'),
    exclude_investment: normalizeList(doc.exclude_investment, 'exclude_investment'),
    rules,
  }
}

function normalizeList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`\`${field}\` must be a list of strings`)
  }
  return value.map((v) => normalizeKey(v, field))
}

function normalizeKey(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`\`${field}\` entries must be non-empty strings`)
  }
  return value.trim().toLowerCase()
}
