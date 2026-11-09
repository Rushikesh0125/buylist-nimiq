import { z } from "zod";
import { id, insist, json, jsonBody, member, now, session } from "./http";

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
const configSchema = z.object({ recipient: address, targetLuna: amount });
const contributionSchema = z.object({
  amountLuna: amount,
  accounts: z.array(address).min(1).max(32),
});
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
const head = z.object({
  number: z.number().int().positive(),
  network: z.string(),
});

export async function nimiqRoutes(request: Request, env: Env, path: string) {
  const match = /^\/api\/goals\/([^/]+)\/nimiq(?:\/([a-f0-9-]+))?$/.exec(path);
  if (!match) return;
  const [, goalId, attemptId] = match;
  const method = request.method;
  const user = await session(request, env, method !== "GET");
  const goal = await member(env, goalId, user.id, method === "PUT");
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
    return json({
      enabled,
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
  if (method === "PUT" && !attemptId) {
    insist(
      !goal.purchased && goal.mode === "flexible",
      409,
      "NIMIQ_GOAL_TYPE",
      "Choose an open flexible group goal.",
    );
    const { recipient, targetLuna } = configSchema.parse(
      await jsonBody(request),
    );
    const result = await env.DB.prepare(
      "INSERT INTO nimiq_goals(goal_id,network,recipient,target_luna) VALUES(?,?,?,?) ON CONFLICT(goal_id) DO NOTHING",
    )
      .bind(goalId, network, recipient, targetLuna)
      .run();
    insist(
      result.meta.changes === 1,
      409,
      "NIMIQ_CONFIGURED",
      "This goal already has a receiving address.",
    );
    return json({ ok: true }, 201);
  }

  insist(
    config && config.network === network,
    409,
    "NIMIQ_CONFIG",
    "The goal is unavailable on this network.",
  );
  if (method === "POST" && !attemptId) {
    insist(!goal.purchased, 409, "GOAL_CLOSED", "This goal is closed.");
    const { amountLuna, accounts } = contributionSchema.parse(
      await jsonBody(request),
    );
    const reference = id().replace(/-/g, "");
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO nimiq_contributions(id,goal_id,user_id,amount_luna,accounts_json,network,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)",
    )
      .bind(
        reference,
        goalId,
        user.id,
        amountLuna,
        JSON.stringify(accounts),
        network,
        now(),
      )
      .run();
    insist(
      result.meta.changes === 1,
      409,
      "NIMIQ_PENDING",
      "Resolve your pending contribution first.",
    );
    return json({ id: reference }, 201);
  }

  insist(
    attemptId && (method === "POST" || method === "DELETE"),
    405,
    "METHOD_NOT_ALLOWED",
    "Unsupported request.",
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
  const finalizedHeight = chainHead.number - (chainHead.number % 60);
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
