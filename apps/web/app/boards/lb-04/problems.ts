// Which of LB-04's own notices a failed call gets. The kit sorts a failure into a coarse kind by its status
// alone, and has a notice for each kind; this board has failures that mean more than their status says
// (the kit calls every 503 "unavailable: this deployment has no back end", but the service's 503 with the
// code `analysis_unavailable` means that the model is out of reach while the samples and everything else
// work), so it looks at the failure's code first. The words themselves are in the locale files.
import type { ApiProblem } from '~/board-kit/problem'

/**
 * The board's own notices: the ten files of the day spent, the contract's three redlines made, the model
 * being out of reach, the review not being queued, a file that is not a PDF or is too large, and a
 * contract that is gone (deleted, or past its hour).
 */
export type OwnNotice = 'uploadLimit' | 'redlineLimit' | 'model' | 'queue' | 'notPdf' | 'tooLarge' | 'gone'

/** Picks the board's own notice for a failure, or nothing when the kit's notice for the failure's kind says it right. The code decides, never the status alone. */
export function ownNoticeOf(problem: ApiProblem): OwnNotice | undefined {
  switch (problem.code) {
    case 'upload_limit': return 'uploadLimit'
    case 'redline_limit': return 'redlineLimit'
    case 'analysis_unavailable': return 'model'
    case 'queue_unavailable': return 'queue'
    case 'not_a_pdf': return 'notPdf'
    case 'file_too_large': return 'tooLarge'
    case 'contract_not_found': return 'gone'
    default: return undefined
  }
}
