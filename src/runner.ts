/**
 * E2B sandbox runner: writes a generated Playwright test file into a
 * fresh sandbox, installs Playwright + Chromium, executes the test, and
 * captures pass/fail plus stdout/stderr.
 *
 * Each call spins up a new sandbox so failures are isolated. In a real
 * Cookbook deployment you would build a custom E2B template with
 * Playwright + Chromium pre-baked to skip the install cost; for clarity
 * this example installs from scratch on every run.
 */

import { CommandExitError, Sandbox } from '@e2b/code-interpreter';

import type { GeneratedTest, RunResult } from './types.js';

const TEST_FILE_PATH = '/home/user/test.spec.ts';
const SNAPSHOT_PATH = '/home/user/failure.html';

/**
 * Write the generated test into the sandbox along with a small Playwright
 * config that drops the test runner into the working directory.
 */
async function prepareSandbox(sandbox: Sandbox, code: string): Promise<void> {
  await sandbox.files.write(TEST_FILE_PATH, code);
  await sandbox.files.write(
    '/home/user/playwright.config.ts',
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '/home/user',
  reporter: 'list',
  use: { headless: true },
});
`,
  );
}

/**
 * Install dependencies once per sandbox.
 *
 * `--with-deps` runs apt-get for Chromium's shared libraries (libnspr4,
 * libnss3, libatk, ...). E2B's default `base` template is stripped
 * down, so without this the headless binary fails with
 * "libnspr4.so: cannot open shared object file" when it tries to launch.
 *
 * The whole install is the slow step (~60-90s) -- a production deployment
 * should build a custom E2B template with Playwright + Chromium + deps
 * pre-baked to skip this cost.
 */
async function installPlaywright(sandbox: Sandbox): Promise<void> {
  await sandbox.commands.run(
    'cd /home/user && npm init -y >/dev/null && ' +
      'npm install --silent @playwright/test && ' +
      'npx --yes playwright install --with-deps chromium',
    { timeoutMs: 5 * 60 * 1000 },
  );
}

/**
 * Best-effort capture of the page state at failure time. Reads the
 * snapshot file if the test wrote one (see HEALING_INSTRUCTIONS in
 * healer.ts which asks the LLM to dump page.content() on failure).
 */
async function tryReadSnapshot(sandbox: Sandbox): Promise<string | undefined> {
  try {
    const content = await sandbox.files.read(SNAPSHOT_PATH);
    return typeof content === 'string' ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a generated test once in a fresh sandbox.
 *
 * Caller is responsible for retry / healing -- this function returns
 * structured output for one attempt only.
 */
export async function runInSandbox(
  generated: GeneratedTest,
): Promise<RunResult> {
  const sandbox = await Sandbox.create();
  try {
    await prepareSandbox(sandbox, generated.code);
    await installPlaywright(sandbox);

    // E2B's SDK throws CommandExitError on non-zero exit rather than
    // returning a result. For a test runner that's the wrong default --
    // a failed test IS the signal we want to capture and feed into the
    // healing loop. Catch the typed error and use it directly, since
    // CommandExitError implements CommandResult (exitCode/stdout/stderr
    // are getters on the instance itself).
    let exec: { exitCode: number; stdout: string; stderr: string };
    try {
      exec = await sandbox.commands.run(
        'cd /home/user && npx playwright test --reporter=list 2>&1',
        { timeoutMs: 5 * 60 * 1000 },
      );
    } catch (err) {
      if (!(err instanceof CommandExitError)) throw err;
      exec = err;
    }

    const passed = exec.exitCode === 0;
    const failureSnapshot = passed ? undefined : await tryReadSnapshot(sandbox);

    return {
      passed,
      exitCode: exec.exitCode,
      stdout: exec.stdout,
      stderr: exec.stderr,
      failureSnapshot,
    };
  } finally {
    await sandbox.kill();
  }
}
