// The exports of a meeting, made in the browser from what the board already holds: JSON for a program,
// CSV for a spreadsheet, and the plain-English follow-up a visitor pastes into Automation Studio
// (LB-08). They mirror the API's own exports (services/django-systems/lb09/export.py) field for field,
// so a replay, which never calls the back end, exports the same thing a live run does. Every export
// says that the speaker labels were inferred from the words, not matched to voices.
import type { Item, Meeting, Segment } from './schemas.ts'

/** The three formats. */
export const EXPORT_FORMATS = ['json', 'csv', 'text'] as const
/** One format. */
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** What every export says about the labels. */
export const LABELS_NOTE = 'Speaker labels are inferred from the words, not matched to voices.'

/** An export ready to save: its content, its media type and a file name. */
export interface ExportFile {
  format: ExportFormat
  filename: string
  contentType: string
  content: string
}

/** Writes the meeting, its transcript and its items as one JSON document. */
export function exportJson(meeting: Meeting, segments: readonly Segment[], items: readonly Item[]): string {
  const document = {
    meeting: {
      id: meeting.id,
      mode: meeting.mode,
      duration_seconds: meeting.duration_seconds,
      transcriber: meeting.transcriber,
      labels_note: LABELS_NOTE,
    },
    items: items.map(item => ({ kind: item.kind, text: item.text, owner: item.owner, deadline: item.deadline, evidence: item.evidence, start: item.start, end: item.end })),
    transcript: segments.map(segment => ({ start: segment.start, end: segment.end, speaker: segment.label, text: segment.text })),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** The characters a spreadsheet reads as the start of a formula. */
const FORMULA_STARTS = ['=', '+', '-', '@', '\t', '\r']

/**
 * Makes a cell of free text safe to open in a spreadsheet: control characters out, and a cell that begins
 * like a formula (`=`, `+`, `-`, `@`, a tab or a carriage return) turned into text with a leading quote.
 * This mirrors the API's `safe_cell` (services/django-systems/lb09/export.py), so a replay exports exactly
 * what a live run does (docs/SECURITY.md, section 4).
 */
export function safeCell(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ')
  // Drop C0 control characters and DEL, keeping the tab, which the formula check below still catches.
  const cleaned = [...flat].filter(character => character === '\t' || !(character <= '\u001f' || character === '\u007f')).join('')
  const leading = cleaned.replace(/^\s+/, '').normalize('NFKC').slice(0, 1)
  if (FORMULA_STARTS.some(start => cleaned.startsWith(start)) || ['=', '+', '-', '@'].includes(leading)) return `'${cleaned}`
  return cleaned
}

/** Quotes one CSV cell: always in double quotes, with the cell's own doubled. */
function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`
}

/** Writes the items as CSV, one row an item, with a header. Free-text cells are made spreadsheet-safe first. */
export function exportCsv(items: readonly Item[]): string {
  const header = ['kind', 'text', 'owner', 'deadline', 'start_seconds', 'end_seconds', 'evidence']
  const rows = items.map(item => [item.kind, safeCell(item.text), safeCell(item.owner ?? ''), safeCell(item.deadline ?? ''), String(item.start), String(item.end), safeCell(item.evidence)].map(csvCell).join(','))
  return `${[header.map(csvCell).join(','), ...rows].join('\n')}\n`
}

/** Says an action as a sentence: who does what, and by when, as far as the meeting said. */
function actionSentence(item: Item): string {
  const owner = item.owner ?? 'Someone still to be named'
  const deadline = item.deadline ? ` by ${item.deadline}` : ''
  return `${owner}: ${item.text}${deadline}.`
}

/** Writes the follow-up as the description of a process, for Automation Studio (LB-08) to turn into a workflow. */
export function exportText(items: readonly Item[]): string {
  const decisions = items.filter(item => item.kind === 'decision')
  const actions = items.filter(item => item.kind === 'action')
  const lines = ['When the minutes of this meeting are approved, follow up on them.']
  if (decisions.length > 0) lines.push(`Post these decisions to the team channel: ${decisions.map(item => `${item.text}.`).join(' ')}`)
  if (actions.length > 0) {
    lines.push('Send each owner a reminder of their action item, and a second one the day before its deadline:')
    lines.push(...actions.map(action => `- ${actionSentence(action)}`))
  }
  else {
    lines.push('There are no action items to remind anyone of.')
  }
  lines.push(`(${LABELS_NOTE})`)
  return `${lines.join('\n')}\n`
}

/** Makes one export of a meeting in a format. */
export function exportMeeting(format: ExportFormat, meeting: Meeting, segments: readonly Segment[], items: readonly Item[]): ExportFile {
  switch (format) {
    case 'json': return { format, filename: `meeting-${meeting.id}.json`, contentType: 'application/json', content: exportJson(meeting, segments, items) }
    case 'csv': return { format, filename: `meeting-${meeting.id}.csv`, contentType: 'text/csv', content: exportCsv(items) }
    default: return { format, filename: `meeting-${meeting.id}.txt`, contentType: 'text/plain', content: exportText(items) }
  }
}
