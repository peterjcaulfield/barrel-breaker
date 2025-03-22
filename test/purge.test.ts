import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { purgeBarrels } from '../lib/purge.js';

describe('purge command integration test', () => {
  const fixtureDir = path.resolve(__dirname, 'fixture');
  const tempDir = path.join(os.tmpdir(), 'barrel-breaker-purge-test');

  beforeEach(() => {
    // Copy the fixture into a temporary directory for isolation.
    fs.copySync(fixtureDir, tempDir);
  });

  afterEach(() => {
    // Remove the temporary directory after the test.
    fs.removeSync(tempDir);
  });

  it('deletes pure barrel files and leaves impure barrel files', () => {
    // Run the purge command (without dry-run).
    purgeBarrels(tempDir, false);

    // Define the expected file paths.
    const pureBarrelFiles = [
      path.join(tempDir, 'modules', 'index.ts'),
      path.join(tempDir, 'modules', 'components', 'index.ts'),
      path.join(tempDir, 'modules', 'nested', 'index.ts')
    ];
    // For the impure barrel file, ensure your fixture actually contains non-export code.
    const impureBarrelFile = path.join(tempDir, 'modules', 'impure-barrel', 'index.ts');

    // Check that pure barrel files are deleted.
    pureBarrelFiles.forEach(filePath => {
      expect(fs.existsSync(filePath)).toBe(false);
    });

    // Check that the impure barrel file still exists.
    expect(fs.existsSync(impureBarrelFile)).toBe(true);
  });
});

