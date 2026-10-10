// The vocabulary of LB-05's SQL safety, as the back end's own OpenAPI document spells it
// (services/flask-systems/openapi.json, the `Layer`, `Rule` and `Outcome` schemas): the six layers a
// query passes through, the rules a layer can stop it for, and how a question can end. The board, its
// samples, its words and the mock back end all draw on this one list, and a test compares it with the
// document, so a layer or rule the back end adds shows up as a failing test and not as a blank on the page.

/** The defences a query passes through, in the order it meets them. */
export const SQL_LAYERS = ['parse', 'allowlist', 'explain', 'connection', 'row_limit', 'timeout'] as const

/** One of the six layers. */
export type SqlLayer = (typeof SQL_LAYERS)[number]

/** What a layer can find wrong, in the order the back end lists them. */
export const SQL_RULES = [
  'empty',
  'too_long',
  'invalid_characters',
  'syntax_error',
  'too_complex',
  'multiple_statements',
  'not_select',
  'catalog_access',
  'file_access',
  'table_function',
  'unknown_table',
  'unknown_column',
  'function_not_allowed',
  'construct_not_allowed',
  'join_not_allowed',
  'limit_not_allowed',
  'too_many_columns',
  'unstable_rendering',
  'check_failed',
  'binder_error',
  'plan_too_large',
  'cross_product',
  'connection_refused',
  'runtime_error',
  'out_of_memory',
  'timeout',
  'row_cap',
] as const

/** One of the rules a layer applies. */
export type SqlRule = (typeof SQL_RULES)[number]

/** How a question can end: answered, declined by the model, refused by a layer, or not answerable right now. */
export const QUESTION_OUTCOMES = ['answered', 'declined', 'refused', 'unavailable'] as const

/** One of the four ways a question ends. */
export type QuestionOutcome = (typeof QUESTION_OUTCOMES)[number]

/** The kinds of value a result column holds. */
export const COLUMN_KINDS = ['text', 'integer', 'number', 'date', 'boolean', 'other'] as const

/** One kind of result column. */
export type ColumnKind = (typeof COLUMN_KINDS)[number]
