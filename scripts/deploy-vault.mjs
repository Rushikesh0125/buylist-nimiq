import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, sepolia } from "viem/chains";
import { compileVault } from "./compile-vault.mjs";

const { VAULT_CHAIN, VAULT_RPC_URL, VAULT_TOKEN, VAULT_DEPLOYER_PRIVATE_KEY } =
  process.env;
const chain =
  VAULT_CHAIN === "sepolia"
    ? sepolia
    : VAULT_CHAIN === "polygon"
      ? polygon
      : undefined;
if (
  !chain ||
  !VAULT_RPC_URL ||
  !VAULT_TOKEN ||
  !isAddress(VAULT_TOKEN) ||
  !/^0x[a-f0-9]{64}$/i.test(VAULT_DEPLOYER_PRIVATE_KEY ?? "")
) {
  throw new Error(
    "Set VAULT_CHAIN (sepolia or polygon), VAULT_RPC_URL, VAULT_TOKEN and VAULT_DEPLOYER_PRIVATE_KEY.",
  );
}
const token = getAddress(VAULT_TOKEN);
const account = privateKeyToAccount(VAULT_DEPLOYER_PRIVATE_KEY);
const transport = http(VAULT_RPC_URL);
const client = createPublicClient({ chain, transport });
if ((await client.getChainId()) !== chain.id)
  throw new Error("Deployment RPC is on the wrong chain.");
if (!(await client.getCode({ address: token })))
  throw new Error("The token address has no deployed contract.");
const wallet = createWalletClient({ account, chain, transport });
const artifact =
  compileVault()["contracts/PersonalSavingsVault.sol"].PersonalSavingsVault;
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: "0x" + artifact.evm.bytecode.object,
  args: [token],
});
console.log("Deployment submitted:", hash);
const receipt = await client.waitForTransactionReceipt({
  hash,
  timeout: 180_000,
});
if (receipt.status !== "success" || !receipt.contractAddress)
  throw new Error("Vault deployment failed.");
console.log("VITE_SAVINGS_VAULT_CHAIN=" + VAULT_CHAIN);
console.log("VITE_SAVINGS_VAULT_ADDRESS=" + receipt.contractAddress);
console.log("VITE_SAVINGS_VAULT_TOKEN=" + token);
