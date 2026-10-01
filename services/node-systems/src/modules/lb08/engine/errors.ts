// How a step can go wrong, and what each way means for the run.
//
// A step error is either retryable (the connector was unavailable: try again, up to the
// step's attempts) or permanent (the step can never work as written: stop at once). Messages
// are short fixed sentences, never a visitor's words, because they go into the run's log.

/** Why a step failed: a stable code for callers and the log, and whether another attempt could help. */
export class StepError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'StepError'
    this.code = code
    this.retryable = retryable
  }
}

/** A sandboxed connector is "down": the visitor asked for this failure, or a real one would look the same. Retrying can help. */
export class ConnectorUnavailableError extends StepError {
  constructor() {
    super('connector_unavailable', 'The connector is unavailable.', true)
    this.name = 'ConnectorUnavailableError'
  }
}

/** The step can never work as written, for example a product that isn't in stock.yaml. Retrying would only repeat it. */
export class PermanentStepError extends StepError {
  constructor(code: string, message: string) {
    super(code, message, false)
    this.name = 'PermanentStepError'
  }
}

/**
 * Stands in for the process dying: nothing after the point it is thrown runs, and the
 * engine records nothing, exactly as if the worker had been killed. Only tests throw it,
 * through the `afterEffect` hook, to prove a side effect that was sent but never
 * acknowledged is not sent again when the step is retried.
 */
export class StepKilled extends Error {
  constructor() {
    super('The worker was killed.')
    this.name = 'StepKilled'
  }
}

/**
 * What `runStep` throws so the queue knows what to do with the job: retry it, or give up.
 * It carries no visitor text; the run's log has the story.
 */
export class StepFailure extends Error {
  // True when the queue should try the step again.
  readonly retry: boolean

  constructor(retry: boolean) {
    super(retry ? 'The step failed and will be retried.' : 'The step failed for good.')
    this.name = 'StepFailure'
    this.retry = retry
  }
}
