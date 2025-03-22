#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import { runBarrelBreaker } from '../lib/barrelBreaker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtureDir = path.resolve(__dirname, 'fixture');
const tsconfigPath = path.join(fixtureDir, 'tsconfig.json');
await runBarrelBreaker(fixtureDir, true, tsconfigPath);
