#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import { purgeBarrels } from '../lib/purge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtureDir = path.resolve(__dirname, 'fixture');
purgeBarrels(fixtureDir, true);
