import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type EIP1193Provider,
  type Hash,
} from "viem";
import { polygon, sepolia } from "viem/chains";

const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function goals(address owner, bytes32 id) view returns (uint256 target, uint256 funded, uint8 status)",
  "function openGoal(bytes32 id, uint256 target)",
  "function deposit(bytes32 id, uint256 amount)",
  "function withdraw(bytes32 id)",
  "function abort(bytes32 id)",
]);

const configuredAddress = import.meta.env.VITE_SAVINGS_VAULT_ADDRESS;
const configuredChain = import.meta.env.VITE_SAVINGS_VAULT_CHAIN;
const configuredToken = import.meta.env.VITE_SAVINGS_VAULT_TOKEN;
const chain =
  configuredChain === "polygon"
    ? polygon
    : configuredChain === "sepolia"
      ? sepolia
      : undefined;
export const vaultDeployment =
  chain &&
  configuredAddress &&
  isAddress(configuredAddress) &&
  getAddress(configuredAddress) !== zeroAddress &&
  configuredToken &&
  isAddress(configuredToken) &&
  getAddress(configuredToken) !== zeroAddress
    ? {
        chain,
        address: getAddress(configuredAddress),
        expectedToken: getAddress(configuredToken),
      }
    : undefined;

export function connectSavingsVault(
  deployment: NonNullable<typeof vaultDeployment>,
  provider: EIP1193Provider,
  goalId: string,
) {
  const { chain, address } = deployment;
  const goalKey = keccak256(stringToHex("Buylist goal:" + goalId));
  const wallet = createWalletClient({
    chain,
    transport: custom(provider, { retryCount: 0 }),
  });
  const client = createPublicClient({
    chain,
    transport: http(import.meta.env.VITE_SAVINGS_VAULT_RPC_URL || undefined, {
      timeout: 10_000,
    }),
  });
  const vault = { address, abi: vaultAbi } as const;

  async function metadata() {
    if ((await client.getChainId()) !== chain.id)
      throw new Error("The savings RPC is on the wrong network.");
    const token = await client.readContract({
      ...vault,
      functionName: "token",
    });
    if (getAddress(token) !== deployment.expectedToken)
      throw new Error("The savings contract uses an unexpected token.");
    const tokenContract = { address: token, abi: erc20Abi } as const;
    const [symbol, decimals] = await Promise.all([
      client.readContract({ ...tokenContract, functionName: "symbol" }),
      client.readContract({ ...tokenContract, functionName: "decimals" }),
    ]);
    return { tokenContract, symbol, decimals };
  }

  async function confirm(
    hash: Hash,
    report: (hash: Hash) => void,
    settled: () => void,
  ) {
    report(hash);
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 90_000,
    });
    if (receipt.transactionHash !== hash) {
      settled();
      throw new Error(
        "The wallet replaced this transaction. Refresh the goal to check what changed.",
      );
    }
    if (receipt.status !== "success")
      throw new Error(
        "The transaction reverted. Refresh the goal before trying again.",
      );
    settled();
  }

  async function assertWallet(account: Address) {
    const [active] = await wallet.getAddresses();
    if (!active || getAddress(active) !== account)
      throw new Error("Reconnect the wallet that owns this savings goal.");
    if ((await wallet.getChainId()) !== chain.id)
      throw new Error("Switch to " + chain.name + " before continuing.");
  }

  return {
    async connect() {
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("Nimiq Pay did not share an account.");
      if ((await wallet.getChainId()) !== chain.id)
        await wallet.switchChain({ id: chain.id });
      return getAddress(account);
    },
    async read(account: Address) {
      const { symbol, decimals } = await metadata();
      const [target, funded, status] = await client.readContract({
        ...vault,
        functionName: "goals",
        args: [account, goalKey],
      });
      return { target, funded, status, symbol, decimals };
    },
    async check(hash: Hash) {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async transact(
      account: Address,
      action: "openGoal" | "deposit" | "withdraw" | "abort",
      amount: bigint,
      report: (hash: Hash) => void,
      settled: () => void,
    ) {
      await assertWallet(account);
      const { tokenContract } = await metadata();
      if (action === "deposit") {
        const allowance = await client.readContract({
          ...tokenContract,
          functionName: "allowance",
          args: [account, address],
        });
        if (allowance < amount) {
          if (allowance !== 0n) {
            await confirm(
              await wallet.writeContract({
                ...tokenContract,
                account,
                functionName: "approve",
                args: [address, 0n],
              }),
              report,
              settled,
            );
            await assertWallet(account);
          }
          await confirm(
            await wallet.writeContract({
              ...tokenContract,
              account,
              functionName: "approve",
              args: [address, amount],
            }),
            report,
            settled,
          );
          await assertWallet(account);
        }
      }

      if (action === "openGoal" || action === "deposit") {
        await confirm(
          await wallet.writeContract({
            ...vault,
            account,
            functionName: action,
            args: [goalKey, amount],
          }),
          report,
          settled,
        );
      } else {
        await confirm(
          await wallet.writeContract({
            ...vault,
            account,
            functionName: action,
            args: [goalKey],
          }),
          report,
          settled,
        );
      }
    },
  };
}
