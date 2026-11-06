// Builds the vault with the settings of the Arc testnet deployment recorded in docs/mumbai/STATUS.md
// (solc 0.8.24 from foundry.toml, optimizer 200 runs, EVM cancun), then copies its ABI and creation
// bytecode into the page's public folder. The page then deploys the same build that is on Arc, and its
// code check can match that vault. The repo's own `forge build` uses the optimizer off, which does not.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "../../contracts/evm");
const OUT = resolve(HERE, "../.build/out");
const BUILDS = [["StyxPolicyVault", "vault-artifact.json"], ["StyxVault", "vault-artifact-v2.json"]]; // version 1, version 2

const build = spawnSync("forge", ["build", "src/StyxPolicyVault.sol", "src/StyxVault.sol", "--out", OUT, "--cache-path", resolve(HERE, "../.build/cache"),
  "--optimize", "--optimizer-runs", "200", "--evm-version", "cancun"], { cwd: CONTRACTS, encoding: "utf8" });
if (build.status !== 0) {
  console.error(`forge build failed. Install Foundry (getfoundry.sh).\n${(build.stderr || build.stdout).slice(-600)}`);
  process.exit(1);
}

mkdirSync(join(HERE, "../public"), { recursive: true });
for (const [name, file] of BUILDS) {
  const source = join(OUT, `${name}.sol/${name}.json`);
  let built;
  try {
    built = JSON.parse(readFileSync(source, "utf8"));
  } catch {
    console.error(`Missing ${source} after the build.`);
    process.exit(1);
  }
  const out = {
    abi: built.abi,
    bytecode: built.bytecode.object,
    deployedBytecode: built.deployedBytecode.object,
    immutableReferences: built.deployedBytecode.immutableReferences ?? {},
  };
  writeFileSync(join(HERE, "../public", file), JSON.stringify(out));
  console.log(`wrote public/${file}`);
}
