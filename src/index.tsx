#!/usr/bin/env bun
import { config } from 'dotenv';
import { runCli } from './cli.js';
import { loginWithOAuth } from './auth/openai-oauth';

// Load environment variables
config({ quiet: true });

if (process.argv[2] === 'login') {
  await loginWithOAuth();
  process.exit(0);
}

await runCli();
