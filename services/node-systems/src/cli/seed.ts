// `just node-seed`: loads each system's synthetic data from data/seed into its schema, after
// checking the files strictly. It makes the tables match the files, so running it again (the
// nightly reseed does) puts the data back as it was.
import { loadEnv } from '../core/env.ts'
import { MODULES } from '../modules/registry.ts'

const env = loadEnv(process.env, 'tool')
for (const module of MODULES) console.log(await module.seed(env))
