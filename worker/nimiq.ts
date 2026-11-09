import { z } from "zod";
import { validDate } from "../shared/domain";
import { insist, json, jsonBody, member, now, session } from "./http";

const address = z
  .string()
  .max(48)
  .transform((value) => value.replace(/ /g, "").toUpperCase())
  .refine((value) => {
    if (!/^NQ[0-9]{2}[0-9A-HJ-NP-VXY]{32}$/.test(value)) return false;
    let remainder = 0;
    for (const character of value.slice(4) + value.slice(0, 4)) {
      const digit = parseInt(character, 36);
      remainder = (remainder * (digit < 10 ? 10 : 100) + digit) % 97;
    }
    return remainder === 1;
  })
  .transform((value) => value.match(/.{4}/g)!.join(" "));
const amount = z.number().int().min(1).max(1_000_000_000_000);
const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());
const personalSavings = z
  .object({
    address,
    targetLuna: amount,
    earmarkedLuna: z.number().int().min(0).max(1_000_000_000_000),
    reviewDate: z.string().refine(validDate).nullable(),
  })
  .refine((value) => value.earmarkedLuna <= value.targetLuna);
type PersonalSavings = {
  address: string;
  target_luna: number;
  earmarked_luna: number;
  review_date: string | null;
};
type Network = "mainnet" | "testnet";
type Config = { recipient: string; network: Network; target_luna: number };
type Attempt = {
  id: string;
  amount_luna: number;
  accounts_json: string;
  tx_hash: string | null;
  status: string;
};

async function rpc(env: Env, method: string, params: unknown[]) {
  const response = await fetch(env.NIMIQ_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
    redirect: "manual",
  });
  insist(
    response.status < 300 || response.status >= 400,
    502,
    "NIMIQ_RPC",
    "Nimiq verification is temporarily unavailable.",
  );
  const payload = await response.json<{
    result?: { data: unknown };
    error?: { code: number; message: string; data?: unknown };
  }>();
  if (
    method === "getTransactionByHash" &&
    payload.error?.code === -32603 &&
    payload.error.data === "Transaction not found: " + params[0]
  )
    return null;
  insist(
    response.ok && payload.result && !payload.error,
    502,
    "NIMIQ_RPC",
    "Nimiq verification is temporarily unavailable.",
  );
  return payload.result.data;
}

const transaction = z.object({
  hash,
  from: address,
  to: address,
  value: amount,
  recipientData: z.string(),
  executionResult: z.boolean(),
  blockNumber: z.number().int().positive(),
});
const chainPolicy = z.object({
  genesisBlockNumber: z.number().int().nonnegative(),
  blocksPerBatch: z.number().int().positive(),
});
const head = z.object({
  number: z.number().int().positive(),
  network: z.string(),
});

async function walletBalance(env: Env, network: Network, wallet: string) {
  const [chain, account] = await Promise.all([
    rpc(env, "getLatestBlock", [false]),
    rpc(env, "getAccountByAddress", [wallet]),
  ]);
  insist(
    head.parse(chain).network ===
      (network === "mainnet" ? "MainAlbatross" : "TestAlbatross"),
    502,
    "NIMIQ_RPC_NETWORK",
    "The verification node is on the wrong network.",
  );
  const record = z
    .object({
      address,
      balance: z.number().int().nonnegative(),
      type: z.literal("basic"),
    })
    .safeParse(account);
  insist(
    record.success && record.data.address === wallet,
    502,
    "NIMIQ_WALLET_BALANCE",
    "Could not verify this wallet balance.",
  );
  return record.data.balance;
}

export async function nimiqRoutes(request: Request, env: Env, path: string) {
  const match = /^\/api\/goals\/([^/]+)\/nimiq(?:\/([a-f0-9-]+))?$/.exec(path);
  if (!match) return;
  const [, goalId, attemptId] = match;
  const method = request.method;
  const user = await session(request, env, method !== "GET");
  const goal = await member(env, goalId, user.id);
  const network = env.NIMIQ_NETWORK;
  const enabled =
    !!env.NIMIQ_RPC_URL && (network === "mainnet" || network === "testnet");
  const config = await env.DB.prepare(
    "SELECT recipient,network,target_luna FROM nimiq_goals WHERE goal_id=?",
  )
    .bind(goalId)
    .first<Config>();

  if (method === "GET" && !attemptId) {
    const summary = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_luna),0) AS confirmed FROM nimiq_contributions WHERE goal_id=? AND status='confirmed'",
    )
      .bind(goalId)
      .first<{ confirmed: number }>();
    const pending = await env.DB.prepare(
      "SELECT id,amount_luna,tx_hash FROM nimiq_contributions WHERE goal_id=? AND user_id=? AND status='pending'",
    )
      .bind(goalId, user.id)
      .first();
    const savings = enabled
      ? await env.DB.prepare(
          "SELECT address,target_luna,earmarked_luna,review_date FROM personal_nim_savings WHERE goal_id=? AND user_id=? AND network=?",
        )
          .bind(goalId, user.id, network)
          .first<PersonalSavings>()
      : null;
    const balance = savings
      ? await walletBalance(env, network as Network, savings.address).catch(
          () => null,
        )
      : null;
    const total = savings
      ? await env.DB.prepare(
          "SELECT COALESCE(SUM(s.earmarked_luna),0) AS amount FROM personal_nim_savings s JOIN goals g ON g.id=s.goal_id WHERE s.user_id=? AND s.network=? AND s.address=? AND g.purchased=0",
        )
          .bind(user.id, network, savings.address)
          .first<{ amount: number }>()
      : null;
    return json({
      enabled,
      network: enabled ? network : null,
      savings: savings && {
        ...savings,
        balance,
        totalEarmarked: total?.amount ?? 0,
      },
      config,
      confirmed: summary?.confirmed ?? 0,
      pending,
    });
  }

  insist(
    enabled,
    503,
    "NIMIQ_DISABLED",
    "Nimiq contributions are unavailable.",
  );
  if (method === "PATCH" && !attemptId) {
    insist(!goal.purchased, 409, "GOAL_CLOSED", "This goal is closed.");
    const savings = personalSavings.parse(await jsonBody(request));
    const balance = await walletBalance(env, network, savings.address);
    // Check other goals and write the allocation in the same SQLite statement.
    const result = await env.DB.prepare(
      "INSERT INTO personal_nim_savings(goal_id,user_id,network,address,target_luna,earmarked_luna,review_date) " +
        "SELECT ?,?,?,?,?,?,? WHERE ? = 0 OR ? + COALESCE((SELECT SUM(s.earmarked_luna) FROM personal_nim_savings s JOIN goals g ON g.id=s.goal_id WHERE s.user_id=? AND s.network=? AND s.address=? AND s.goal_id<>? AND g.purchased=0),0) <= ? OR EXISTS (SELECT 1 FROM personal_nim_savings WHERE goal_id=? AND user_id=? AND network=? AND address=? AND earmarked_luna>=?) " +
        "ON CONFLICT(goal_id,user_id,network) DO UPDATE SET address=excluded.address,target_luna=excluded.target_luna,earmarked_luna=excluded.earmarked_luna,review_date=excluded.review_date",
    )
      .bind(
        goalId,
        user.id,
        network,
        savings.address,
        savings.targetLuna,
        savings.earmarkedLuna,
        savings.reviewDate,
        savings.earmarkedLuna,
        savings.earmarkedLuna,
        user.id,
        network,
        savings.address,
        goalId,
        balance,
        goalId,
        user.id,
        network,
        savings.address,
        savings.earmarkedLuna,
      )
      .run();
    insist(
      result.meta.changes === 1,
      409,
      "NIMIQ_INSUFFICIENT_BALANCE",
      "That amount and your other goals exceed the available wallet balance.",
    );
    return json({ ok: true });
  }

  insist(
    attemptId && (method === "POST" || method === "DELETE"),
    405,
    "METHOD_NOT_ALLOWED",
    "New savings use personal wallet tracking.",
  );
  insist(
    config && config.network === network,
    409,
    "NIMIQ_CONFIG",
    "The transfer is unavailable on this network.",
  );
  const attempt = await env.DB.prepare(
    "SELECT id,amount_luna,accounts_json,tx_hash,status FROM nimiq_contributions WHERE id=? AND goal_id=? AND user_id=?",
  )
    .bind(attemptId, goalId, user.id)
    .first<Attempt>();
  insist(attempt, 404, "NIMIQ_ATTEMPT", "Contribution not found.");
  if (method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE nimiq_contributions SET status='canceled' WHERE id=? AND status='pending' AND tx_hash IS NULL",
    )
      .bind(attemptId)
      .run();
    insist(
      result.meta.changes === 1,
      409,
      "NIMIQ_SUBMITTED",
      "This contribution can no longer be canceled.",
    );
    return json({ ok: true });
  }

  const { txHash } = z.object({ txHash: hash }).parse(await jsonBody(request));
  if (attempt.status === "confirmed" && attempt.tx_hash === txHash)
    return json({ status: "confirmed" });
  insist(
    attempt.status === "pending",
    409,
    "NIMIQ_CLOSED",
    "This contribution is closed.",
  );
  await env.DB.prepare(
    "UPDATE nimiq_contributions SET tx_hash=? WHERE id=? AND status='pending'",
  )
    .bind(txHash, attemptId)
    .run();
  const chainHead = head.parse(await rpc(env, "getLatestBlock", [false]));
  insist(
    chainHead.network ===
      (network === "mainnet" ? "MainAlbatross" : "TestAlbatross"),
    502,
    "NIMIQ_RPC_NETWORK",
    "The verification node is on the wrong network.",
  );

  const chainData = await rpc(env, "getTransactionByHash", [txHash]);
  if (!chainData) return json({ status: "pending" }, 202);
  const tx = transaction.parse(chainData);
  const referenceHex = Array.from(new TextEncoder().encode(attemptId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  insist(
    tx.hash === txHash &&
      tx.executionResult &&
      tx.to === config.recipient &&
      tx.value === attempt.amount_luna &&
      tx.recipientData.toLowerCase() === referenceHex &&
      (JSON.parse(attempt.accounts_json) as string[]).includes(tx.from),
    422,
    "NIMIQ_TRANSFER_MISMATCH",
    "This transaction does not match the contribution.",
  );
  // Wait until the containing batch has ended in a finalized macro block.
  const { genesisBlockNumber, blocksPerBatch } = chainPolicy.parse(
    await rpc(env, "getPolicyConstants", []),
  );
  const blocksSinceGenesis = chainHead.number - genesisBlockNumber;
  insist(
    blocksSinceGenesis >= 0,
    502,
    "NIMIQ_RPC_HEIGHT",
    "Nimiq verification is temporarily unavailable.",
  );
  const finalizedHeight =
    chainHead.number - (blocksSinceGenesis % blocksPerBatch);
  if (tx.blockNumber > finalizedHeight) return json({ status: "pending" }, 202);
  const result = await env.DB.prepare(
    "UPDATE OR IGNORE nimiq_contributions SET tx_hash=?,status='confirmed' WHERE id=? AND status='pending'",
  )
    .bind(txHash, attemptId)
    .run();
  if (result.meta.changes !== 1) {
    const existing = await env.DB.prepare(
      "SELECT tx_hash,status FROM nimiq_contributions WHERE id=?",
    )
      .bind(attemptId)
      .first<Attempt>();
    insist(
      existing?.status === "confirmed" && existing.tx_hash === txHash,
      409,
      "NIMIQ_ALREADY_USED",
      "This transfer could not be credited.",
    );
  }
  return json({ status: "confirmed" });
}
