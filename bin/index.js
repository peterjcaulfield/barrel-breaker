#!/usr/bin/env node
import { Command } from "commander";
import { runBarrelBreaker } from "../lib/barrelBreaker.js";

const program = new Command();

program
  .name("barrel-breaker")
  .argument("<path>", "file or directory to process")
  .option("--dry-run", "preview changes without writing", false)
  .option("--tsconfig <path>", "Path to tsconfig.json", "tsconfig.json")
  .action((inputPath, options) => {
    runBarrelBreaker(inputPath, options.dryRun, options.tsconfig);
  });

program.parse();

