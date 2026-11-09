import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";

const require = createRequire(import.meta.url);
export function compileVault(extraSources = {}) {
  const source = "contracts/PersonalSavingsVault.sol";
  const input = {
    language: "Solidity",
    sources: {
      [source]: {
        content: readFileSync(new URL("../" + source, import.meta.url), "utf8"),
      },
      ...extraSources,
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (name) => {
        try {
          return { contents: readFileSync(require.resolve(name), "utf8") };
        } catch {
          return { error: "Unable to resolve Solidity import: " + name };
        }
      },
    }),
  );
  const errors =
    output.errors?.filter((issue) => issue.severity === "error") ?? [];
  if (errors.length)
    throw new Error(errors.map((issue) => issue.formattedMessage).join("\n"));
  return output.contracts;
}
