// Which of LB-10's own notices a failed call gets. The kit sorts a failure into a coarse kind by its status alone,
// and has a notice for each kind; this board has failures that mean more than their status says (a 503 is "the lab
// is full, try in a minute" or "the lab has no gateway", a 429 is "today's run is used" or "your run is still
// going", a 404 for a run is a run that is gone), so it looks at the failure's code first. A refused prompt is not a
// notice at all: the editor lists its problems beside the prompt. The words are in the locale files.
import type { ApiProblem } from '~/board-kit/problem'

/** The board's own notices, by the service's code. */
export type OwnNotice = 'lab_busy' | 'run_running' | 'daily_limit' | 'unavailable' | 'invalid_providers' | 'unknown_target' | 'gone'

/** Picks the board's own notice for a failure, or nothing when the kit's notice for its kind says it right. The code decides, never the status alone. */
export function ownNoticeOf(problem: ApiProblem): OwnNotice | undefined {
  switch (problem.code) {
    case 'lab_busy':
    case 'run_running':
    case 'daily_limit':
    case 'invalid_providers':
    case 'unknown_target':
      return problem.code
    case 'unavailable':
      return problem.status === 503 ? 'unavailable' : undefined
    case 'not_found':
      return problem.status === 404 ? 'gone' : undefined
    default:
      return undefined
  }
}

/** Tells whether a failure is the service refusing the prompt, which the editor shows beside the prompt instead of a notice. */
export function isRefusedPrompt(problem: ApiProblem | undefined): boolean {
  return problem?.code === 'invalid_prompt'
}
