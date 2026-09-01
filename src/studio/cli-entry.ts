#!/usr/bin/env node
import { runStudioCli } from './cli.js'

void runStudioCli(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
