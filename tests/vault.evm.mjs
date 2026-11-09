import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { foundry } from "viem/chains";
import { compileVault } from "../scripts/compile-vault.mjs";

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
await new Promise((resolve) => server.close(resolve));
const anvil = spawn(
  process.env.ANVIL_PATH || "anvil",
  ["--host", "127.0.0.1", "--port", String(port), "--silent"],
  { stdio: "inherit" },
);
let startupError;
anvil.once("error", (error) => {
  startupError = error;
});
const transport = http("http://127.0.0.1:" + port, {
  retryCount: 0,
  timeout: 1000,
});
const publicClient = createPublicClient({ chain: foundry, transport });
const wallet = createWalletClient({ chain: foundry, transport });

try {
  for (let tries = 0; ; tries++) {
    if (startupError) throw startupError;
    try {
      assert.equal(await publicClient.getChainId(), foundry.id);
      break;
    } catch (error) {
      if (tries >= 30) throw error;
      await setTimeout(100);
    }
  }

  const [owner, stranger] = await wallet.getAddresses();
  const artifacts = compileVault({
    "TestToken.sol": {
      content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract TestToken is ERC20 {
    constructor() ERC20("Test savings token", "TEST") { _mint(msg.sender, 1000); }
}`,
    },
  });
  async function deploy(artifact, args = []) {
    const hash = await wallet.deployContract({
      account: owner,
      abi: artifact.abi,
      bytecode: "0x" + artifact.evm.bytecode.object,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt.contractAddress;
  }

  const token = await deploy(artifacts["TestToken.sol"].TestToken);
  const artifact =
    artifacts["contracts/PersonalSavingsVault.sol"].PersonalSavingsVault;
  const address = await deploy(artifact, [token]);
  const tokenErrors = artifacts["TestToken.sol"].TestToken.abi.filter(
    (entry) => entry.type === "error",
  );
  const vault = { address, abi: [...artifact.abi, ...tokenErrors] };
  const erc20 = { address: token, abi: erc20Abi };
  const goal = keccak256(stringToHex("goal"));
  const refundGoal = keccak256(stringToHex("refund"));
  const balance = (account) =>
    publicClient.readContract({
      ...erc20,
      functionName: "balanceOf",
      args: [account],
    });
  const state = (account, id) =>
    publicClient.readContract({
      ...vault,
      functionName: "goals",
      args: [account, id],
    });
  const rejected = (account, functionName, args, error) =>
    assert.rejects(
      publicClient.simulateContract({ ...vault, account, functionName, args }),
      new RegExp(error),
    );
  async function send(contract, account, functionName, args) {
    const hash = await wallet.writeContract({
      ...contract,
      account,
      functionName,
      args,
    });
    assert.equal(
      (await publicClient.waitForTransactionReceipt({ hash })).status,
      "success",
    );
  }

  await rejected(owner, "openGoal", [goal, 0n], "InvalidTarget");
  await send(vault, owner, "openGoal", [goal, 100n]);
  await rejected(owner, "openGoal", [goal, 120n], "GoalExists");
  await rejected(owner, "deposit", [goal, 30n], "ERC20InsufficientAllowance");
  assert.deepEqual(await state(owner, goal), [100n, 0n, 1]);
  await send(erc20, owner, "approve", [address, 200n]);
  await send(vault, owner, "deposit", [goal, 30n]);
  await rejected(owner, "withdraw", [goal], "TargetNotReached");
  await rejected(stranger, "withdraw", [goal], "InactiveGoal");
  await rejected(stranger, "abort", [goal], "InactiveGoal");
  await rejected(stranger, "deposit", [goal, 1n], "InactiveGoal");
  await rejected(owner, "deposit", [goal, 71n], "InvalidDeposit");
  await send(vault, stranger, "openGoal", [goal, 5n]);
  await send(vault, stranger, "abort", [goal]);
  assert.deepEqual(await state(owner, goal), [100n, 30n, 1]);
  await send(vault, owner, "deposit", [goal, 70n]);
  await rejected(owner, "abort", [goal], "TargetReached");
  await send(vault, owner, "withdraw", [goal]);
  assert.equal(await balance(owner), 1000n);
  assert.deepEqual(await state(owner, goal), [100n, 100n, 2]);
  await rejected(owner, "withdraw", [goal], "InactiveGoal");

  await send(vault, owner, "openGoal", [refundGoal, 100n]);
  await send(vault, owner, "deposit", [refundGoal, 40n]);
  assert.equal(await balance(owner), 960n);
  assert.equal(await balance(address), 40n);
  await send(vault, owner, "abort", [refundGoal]);
  assert.equal(await balance(owner), 1000n);
  assert.equal(await balance(address), 0n);
  assert.deepEqual(await state(owner, refundGoal), [100n, 40n, 3]);
  await rejected(owner, "abort", [refundGoal], "InactiveGoal");
  await rejected(owner, "openGoal", [refundGoal, 100n], "GoalExists");
  console.log(
    "Vault EVM checks passed: repeated deposits, early withdrawal rejection, owner isolation, target withdrawal and exact abort refund.",
  );
} finally {
  anvil.kill();
}
