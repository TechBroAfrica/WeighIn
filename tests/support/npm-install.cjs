// Shared npm install invocation for the tests that install a real package.
//
// The CI runners share their egress IP with many other jobs, so a burst of
// registry requests can be answered with a transient failure. The restored npm
// cache already holds the locked tarballs and their metadata, so the install
// prefers the cache and only falls back to the registry. npm's default retry
// budget is two attempts with a short minimum backoff, which is not enough to
// ride out a transient registry failure; the budget below is raised so a
// temporary registry problem fails the test only after a real retry sequence.
const { spawnSync } = require("node:child_process");

const registryEnvironment = {
  npm_config_fetch_retries: "5",
  npm_config_fetch_retry_mintimeout: "10000",
  npm_config_fetch_retry_maxtimeout: "120000",
  npm_config_fetch_timeout: "300000",
};

/**
 * Runs `npm install` for the given arguments and returns the spawn result.
 *
 * @param {string[]} args npm install arguments.
 * @param {{cwd: string, timeout?: number, env?: object, stdio?: any}} options
 *   spawn options; `cwd` is the install directory.
 */
function npmInstall(args, options) {
  const { env, ...rest } = options;
  return spawnSync("npm", ["install", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...registryEnvironment, ...env },
    ...rest,
  });
}

module.exports = { npmInstall, registryEnvironment };
