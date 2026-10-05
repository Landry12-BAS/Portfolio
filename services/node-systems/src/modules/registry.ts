// The systems the Node monolith hosts. A new system joins by adding its module to this list:
// the API mounts its routes, the worker runs its queues, and the migrate, seed and OpenAPI
// commands pick it up, with no other change to the monolith.
import type { SystemModule } from '../core/module.ts'
import { lb04Module } from './lb04/index.ts'
import { lb06Module } from './lb06/index.ts'
import { lb07Module } from './lb07/index.ts'
import { lb08Module } from './lb08/index.ts'

/** Every system this monolith hosts. */
export const MODULES: readonly SystemModule[] = [lb08Module, lb04Module, lb06Module, lb07Module]
