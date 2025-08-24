#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from "commander";
import { runBarrelBreaker } from "../lib/barrelBreaker.js";
import { purgeBarrels } from "../lib/purge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

const program = new Command();

program
  .enablePositionalOptions()
  .name("brl")
  .description("Rewrite barrel imports and purge barrel files.")
  .version(packageJson.version, '-v, --version')
  .argument("[path]", "file or directory to process")
  .option("--pattern <pattern>", "Only process files that match the pattern")
  .option("--dry-run", "Preview changes without writing")
  .option("--tsconfig <path>", "Path to tsconfig.json", "tsconfig.json")
  .option("--verbose", "Enable verbose logging", false)
  .option("--summary", "Log summary when done", false)
  .option("--colors", "Enable colors in logging", false)
  .action(async (inputPath, options) => {
    const targetDir = inputPath ? path.resolve(inputPath) : process.cwd();
    await runBarrelBreaker(
      targetDir,
      options.dryRun,
      options.tsconfig,
      options.verbose,
      options.summary,
      options.colors,
      options.pattern
    );
  });

program
  .command("purge [path]")
  .description("Scan a directory for barrel files and purge those that only contain re-exports.")
  .option("--dry-run", "Log the files that would be deleted, without deleting them")
  .action((inputPath, options) => {
    const targetDir = inputPath ? path.resolve(inputPath) : process.cwd();
    purgeBarrels(targetDir, options.dryRun);
  });

program.parse(process.argv);
