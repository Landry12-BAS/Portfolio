// Starting pdf.js's worker under the site's Content Security Policy. The policy requires Trusted Types for
// scripts, and a worker's address is a script address, so `new Worker(address)` with a plain string is
// refused. The address is made by one named policy, `lb-pdf-worker`, which hands out the one address of
// the worker file the build put in the site's own origin and nothing else (it throws for any other
// text, so this code cannot be used to start another script). The policy's name is the only thing the
// board's route adds to the list of allowed policies (server/lib/lb04-csp.ts), and there is never a
// `default` policy. pdf.js is given the worker we started, as its port, so it never starts one itself.
import { PDF_WORKER_POLICY } from '#shared/lb04-viewer'

/** The part of the Trusted Types API the policy uses: a factory that makes a named policy. */
export interface PolicyFactory {
  createPolicy: (name: string, rules: { createScriptURL: (input: string) => string }) => { createScriptURL: (input: string) => unknown }
}

/** The part of the browser's Worker constructor the start uses. */
export type WorkerConstructor = new (address: string, options: { type: 'module', name: string }) => Worker

// The policy is made once: making a second one with the same name is an error.
let policy: { createScriptURL: (input: string) => unknown } | undefined

/**
 * Makes the worker's address a Trusted Types value where the browser has them, or leaves it text where it
 * has not. `address` is the one address the policy will ever hand out.
 */
export function trustedWorkerUrl(factory: PolicyFactory | undefined, address: string): string {
  if (!factory) return address
  policy ??= factory.createPolicy(PDF_WORKER_POLICY, {
    createScriptURL: (input) => {
      if (input !== address) throw new TypeError('This policy only hands out the PDF worker.')
      return input
    },
  })
  return policy.createScriptURL(address) as string
}

/** Forgets the policy, so a test can make another. A browser keeps its policies until the page goes, and so does the code. */
export function forgetPolicy(): void {
  policy = undefined
}

/** Starts the worker pdf.js will use, from the one address, as a module worker. */
export function startPdfWorker(address: string, host: { trustedTypes?: PolicyFactory, Worker: WorkerConstructor }): Worker {
  return new host.Worker(trustedWorkerUrl(host.trustedTypes, address), { type: 'module', name: 'lb-pdf' })
}
