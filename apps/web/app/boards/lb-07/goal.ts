// Checking a visitor's own goal before it is sent, by the same rule the service applies (`lb07GoalSchema`
// in @lb/contracts): plain text of 3 to 300 characters once trimmed, with no control or formatting
// character, which a goal has no use for and which could hide what it says. The board says which rule a
// goal breaks so the visitor can fix it; the service checks again, and screens what passes for
// instructions to the agent.
import { LB07_LIMITS, lb07GoalSchema } from '@lb/contracts'

/** Why a goal would be refused. */
export type GoalProblem = 'tooShort' | 'tooLong' | 'control'

/** The shortest goal the service takes. */
export const MIN_GOAL_LENGTH = 3
/** The longest goal the service takes. */
export const MAX_GOAL_LENGTH = LB07_LIMITS.maxGoalLength

// A control or formatting character anywhere: the service refuses a goal that has one.
const HIDDEN = /[\p{Cc}\p{Cf}]/u

/** A goal as it is sent: a line break, which a goal has no use for and the service refuses, becomes a space, so a goal typed over several lines or pasted reads as one. */
export function normalizeGoal(goal: string): string {
  return goal.split(/\r\n|\r|\n/).join(' ').trim()
}

/** Says what is wrong with a goal as it would be sent, or nothing when the service would take it. */
export function goalProblem(goal: string): GoalProblem | undefined {
  const trimmed = normalizeGoal(goal)
  if (HIDDEN.test(trimmed)) return 'control'
  if (trimmed.length < MIN_GOAL_LENGTH) return 'tooShort'
  if (trimmed.length > MAX_GOAL_LENGTH) return 'tooLong'
  return lb07GoalSchema.safeParse(trimmed).success ? undefined : 'control'
}
