// Copies the vault's ABI and creation bytecode from Foundry's build output into the page's public
// folder, so the page deploys exactly the contract in this checkout. Run `forge build` first.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../../contracts/evm/out/ErebusPolicyVault.sol/ErebusPolicyVault.json");

let built;
try {
  built = JSON.parse(readFileSync(SOURCE, "utf8"));
} catch {
  console.error(`Missing ${SOURCE}. Run: (cd contracts/evm && forge build)`);
  process.exit(1);
}
const out = {
  abi: built.abi,
  bytecode: built.bytecode.object,
  deployedBytecode: built.deployedBytecode.object,
  immutableReferences: built.deployedBytecode.immutableReferences ?? {},
};
mkdirSync(join(HERE, "../public"), { recursive: true });
writeFileSync(join(HERE, "../public/vault-artifact.json"), JSON.stringify(out));
console.log("wrote public/vault-artifact.json");
