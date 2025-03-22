import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runBarrelBreaker } from '../lib/barrelBreaker.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('barrelBreaker integration test', () => {
  const fixtureDir = path.resolve(__dirname, 'fixture');
  const tempDir = path.join(os.tmpdir(), 'barrel-breaker-test');

  beforeEach(() => {
    // Copy the contents of the fixture directory into the temporary directory.
    fs.copySync(fixtureDir, tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory after test
    fs.removeSync(tempDir);
  });

  it('transforms import-example.ts correctly', async () => {
    // Use the tsconfig file directly from the tempDir
    const tsconfigPath = path.join(tempDir, 'tsconfig.json');
    await runBarrelBreaker(tempDir, false, tsconfigPath);

    // Read the updated file
    const updatedFile = fs.readFileSync(path.join(tempDir, 'import-example.ts'), 'utf8');

    // Snapshot test for the expected output
    expect(updatedFile).toMatchSnapshot();
  });
});

