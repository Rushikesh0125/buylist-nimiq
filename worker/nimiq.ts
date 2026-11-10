import { z } from "zod";
import { addressFromPublicKey } from "../shared/nimiq-address";
import { forecast, validDate, type Frequency } from "../shared/domain";
import {
  balance,
  insist,
  json,
  jsonBody,
  member,
  now,
  session,
  type GoalRow,
} from "./http";

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
    purchaseDate: z.string().refine(validDate).nullable().optional(),
    finalContributionLuna: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
  })
  .refine((value) => value.earmarkedLuna <= value.targetLuna);
type PersonalSavings = {
  address: string;
  target_luna: number;
  earmarked_luna: number;
  review_date: string | null;
  purchase_date: string | null;
  final_contribution_luna: number;
  schedule_usd_rate: number | null;
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
    payload.error?.code === -32603 &&
    ((method === "getTransactionByHash" &&
      payload.error.data === "Transaction not found: " + params[0]) ||
      (method === "getStakerByAddress" &&
        payload.error.data === "No staker with address: " + params[0]))
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

const nonnegative = z.number().int().nonnegative();
const stakerSchema = z.object({
  address,
  balance: nonnegative,
  delegation: address.nullable(),
  inactiveBalance: nonnegative,
  inactiveFrom: nonnegative.nullable(),
  retiredBalance: nonnegative,
});
const stakingPolicy = chainPolicy.extend({
  minimumStake: z.number().int().positive(),
});

async function stakingStatus(
  env: Env,
  network: Network,
  wallet: string,
  txHash: string | null,
) {
  const [rawHead, rawPolicy] = await Promise.all([
    rpc(env, "getLatestBlock", [false]),
    rpc(env, "getPolicyConstants", []),
  ]);
  const chain = head.parse(rawHead);
  insist(
    chain.network ===
      (network === "mainnet" ? "MainAlbatross" : "TestAlbatross"),
    502,
    "NIMIQ_RPC_NETWORK",
    "The verification node is on the wrong network.",
  );
  const policy = stakingPolicy.parse(rawPolicy);
  insist(
    chain.number >= policy.genesisBlockNumber,
    502,
    "NIMIQ_RPC_HEIGHT",
    "Invalid chain height.",
  );

  if (txHash) {
    const expected = hash.parse(txHash);
    const raw = await rpc(env, "getTransactionByHash", [expected]);
    if (!raw) return json({ status: "pending" });
    const tx = z
      .object({ hash, blockNumber: nonnegative, executionResult: z.boolean() })
      .parse(raw);
    insist(
      tx.hash === expected,
      502,
      "NIMIQ_TX_MISMATCH",
      "Unexpected transaction hash.",
    );
    const finalized =
      chain.number -
      ((chain.number - policy.genesisBlockNumber) % policy.blocksPerBatch);
    return json({
      status:
        tx.blockNumber > finalized
          ? "pending"
          : tx.executionResult
            ? "confirmed"
            : "failed",
    });
  }

  const raw = await rpc(env, "getStakerByAddress", [wallet]);
  const staker = raw === null ? null : stakerSchema.parse(raw);
  insist(
    !staker || staker.address === wallet,
    502,
    "NIMIQ_STAKER_MISMATCH",
    "Unexpected staking account.",
  );
  let releaseBlock: number | null = null;
  if (staker && staker.inactiveBalance > 0 && staker.inactiveFrom !== null) {
    const reporting = await rpc(env, "getBlockAfterReportingWindow", [
      staker.inactiveFrom,
    ]);
    releaseBlock = nonnegative.parse(reporting);
    if (staker.delegation) {
      const validator = z
        .object({ jailedFrom: nonnegative.nullable() })
        .parse(await rpc(env, "getValidatorByAddress", [staker.delegation]));
      if (validator.jailedFrom !== null) {
        const jail = await rpc(env, "getBlockAfterJail", [
          validator.jailedFrom,
        ]);
        releaseBlock = Math.max(releaseBlock, nonnegative.parse(jail));
      }
    }
  }
  const validators = staker
    ? []
    : z
        .array(z.object({ address }))
        .parse(await rpc(env, "getActiveValidators", []))
        .map((entry) => entry.address)
        .sort();
  return json({
    staker,
    validators,
    releaseBlock,
    height: chain.number,
    minimumStake: policy.minimumStake,
  });
}

async function scheduleBasis(env: Env, goal: GoalRow, userId: string) {
  if (goal.mode === "flexible") {
    const plan = await env.DB.prepare(
      "SELECT amount_cents,frequency,start_date FROM personal_plans WHERE goal_id=? AND user_id=?",
    )
      .bind(goal.id, userId)
      .first<{
        amount_cents: number;
        frequency: Frequency;
        start_date: string;
      }>();
    if (!plan) return null;
    const cents = Math.max(
      0,
      goal.target_cents - (await balance(env, goal.id)),
    );
    if (Math.ceil(cents / plan.amount_cents) > 600) {
      return {
        cents,
        finalDate: null,
        finalCents: 0,
        contributionCents: Math.min(cents, plan.amount_cents),
      };
    }
    const final = forecast(
      cents,
      plan.amount_cents,
      plan.start_date,
      plan.frequency,
    ).events.at(-1);
    return {
      cents,
      finalDate: final?.date ?? null,
      finalCents: final?.amountCents ?? 0,
      contributionCents: Math.min(cents, plan.amount_cents),
    };
  }
  const commitment = await env.DB.prepare(
    "SELECT 1 FROM commitments WHERE goal_id=? AND user_id=?",
  )
    .bind(goal.id, userId)
    .first();
  if (!commitment) return null;
  const rows = (
    await env.DB.prepare(
      "SELECT date, SUM(amount_cents) AS cents FROM schedule_events WHERE goal_id=? AND user_id=? AND capture_id IS NULL GROUP BY date ORDER BY date",
    )
      .bind(goal.id, userId)
      .all<{ date: string; cents: number }>()
  ).results;
  const final = rows.at(-1);
  return {
    cents: rows.reduce((sum, row) => sum + row.cents, 0),
    finalDate: final?.date ?? null,
    finalCents: final?.cents ?? 0,
    contributionCents: rows[0]?.cents ?? 0,
  };
}

const scheduleInput = z.object({
  fromSchedule: z.literal(true),
  earmarkedLuna: z.number().int().min(0).max(1_000_000_000_000).optional(),
});
const toLuna = (cents: number, rate: number) =>
  Math.ceil((cents * 1000) / rate);

async function scheduleRate() {
  const unavailable =
    "A fresh NIM price is unavailable. Try linking the saved schedule again shortly.";
  const response = await fetch(
    "https://api.coinpaprika.com/v1/tickers/nim-nimiq",
    {
      signal: AbortSignal.timeout(6000),
      redirect: "manual",
    },
  ).catch(() => null);
  insist(response?.ok, 503, "NIMIQ_QUOTE_UNAVAILABLE", unavailable);
  const quote = z
    .object({
      id: z.literal("nim-nimiq"),
      last_updated: z.string(),
      quotes: z.object({
        USD: z.object({ price: z.number().positive() }),
      }),
    })
    .safeParse(await response.json().catch(() => null));
  const updated = quote.success
    ? Date.parse(quote.data.last_updated) / 1000
    : NaN;
  insist(
    quote.success && updated >= now() - 1800 && updated <= now() + 60,
    503,
    "NIMIQ_QUOTE_UNAVAILABLE",
    unavailable,
  );
  return quote.data.quotes.USD.price;
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
          "SELECT address,target_luna,earmarked_luna,review_date,purchase_date,final_contribution_luna,schedule_usd_rate FROM personal_nim_savings WHERE goal_id=? AND user_id=? AND network=?",
        )
          .bind(goalId, user.id, network)
          .first<PersonalSavings>()
      : null;
    const query = new URL(request.url).searchParams;
    if (query.has("staking") || query.has("stakingTx")) {
      insist(
        enabled && savings,
        409,
        "NIMIQ_SAVINGS_REQUIRED",
        "Save a NIM plan before opening staking.",
      );
      if (savings.schedule_usd_rate)
        insist(
          await scheduleBasis(env, goal, user.id),
          409,
          "NIMIQ_SCHEDULE_REQUIRED",
          "Save your schedule before opening staking.",
        );
      return stakingStatus(
        env,
        network,
        savings.address,
        query.get("stakingTx"),
      );
    }
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
    const basis = savings?.schedule_usd_rate
      ? await scheduleBasis(env, goal, user.id)
      : null;
    return json({
      enabled,
      network: enabled ? network : null,
      savings: savings && {
        ...savings,
        ...(basis && savings.schedule_usd_rate
          ? {
              target_luna: Math.max(
                1,
                toLuna(basis.cents, savings.schedule_usd_rate),
              ),
              contribution_luna: toLuna(
                basis.contributionCents,
                savings.schedule_usd_rate,
              ),
              purchase_date: basis.finalDate,
              final_contribution_luna: toLuna(
                basis.finalCents,
                savings.schedule_usd_rate,
              ),
            }
          : {}),
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
    const body = await jsonBody(request);
    const linked = scheduleInput.safeParse(body);
    let rate: number | null = null;
    let savings: z.infer<typeof personalSavings>;
    if (linked.success) {
      const basis = await scheduleBasis(env, goal, user.id);
      insist(
        basis && basis.cents > 0,
        409,
        "NIMIQ_SCHEDULE_REQUIRED",
        "Save a schedule with a remaining contribution before linking staking.",
      );
      const existing = await env.DB.prepare(
        "SELECT address,earmarked_luna,review_date,schedule_usd_rate FROM personal_nim_savings WHERE goal_id=? AND user_id=? AND network=?",
      )
        .bind(goalId, user.id, network)
        .first<PersonalSavings>();
      const identity = await env.DB.prepare(
        "SELECT google_sub FROM users WHERE id=?",
      )
        .bind(user.id)
        .first<{ google_sub: string }>();
      const signer = /^nimiq:([a-f0-9]{64})$/.exec(identity?.google_sub ?? "");
      insist(
        signer,
        409,
        "NIMIQ_SIGN_IN_REQUIRED",
        "Sign in with Nimiq Pay to link your schedule.",
      );
      const walletAddress = addressFromPublicKey(signer[1]);
      if (
        existing?.schedule_usd_rate &&
        existing.address === walletAddress &&
        linked.data.earmarkedLuna === undefined
      ) {
        return json({ ok: true });
      }
      insist(
        !existing ||
          existing.address === walletAddress ||
          existing.earmarked_luna === 0,
        409,
        "NIMIQ_WALLET_CHANGED",
        "Your existing earmark uses a different wallet. It has been preserved.",
      );
      rate = existing?.schedule_usd_rate ?? (await scheduleRate());
      const targetLuna = toLuna(basis.cents, rate);
      insist(
        targetLuna <= 1_000_000_000_000,
        400,
        "NIMIQ_TARGET_LIMIT",
        "The converted NIM target exceeds the supported limit.",
      );
      const earmarkedLuna =
        linked.data.earmarkedLuna ??
        (existing?.address === walletAddress ? existing.earmarked_luna : 0);
      insist(
        earmarkedLuna <= targetLuna,
        409,
        "NIMIQ_EARMARK_TARGET",
        "Reduce your earmark before applying this schedule.",
      );
      savings = {
        address: walletAddress,
        targetLuna,
        earmarkedLuna,
        reviewDate: existing?.review_date ?? null,
        purchaseDate: basis.finalDate,
        finalContributionLuna: toLuna(basis.finalCents, rate),
      };
    } else {
      savings = personalSavings.parse(body);
    }
    const balance =
      savings.earmarkedLuna === 0
        ? 0
        : await walletBalance(env, network, savings.address);
    const automaticLink =
      linked.success && linked.data.earmarkedLuna === undefined;
    // Check other goals and write the allocation in the same SQLite statement.
    const result = await env.DB.prepare(
      "INSERT INTO personal_nim_savings(goal_id,user_id,network,address,target_luna,earmarked_luna,review_date,purchase_date,final_contribution_luna,schedule_usd_rate) " +
        "SELECT ?,?,?,?,?,?,?,?,?,? WHERE ? = 0 OR ? + COALESCE((SELECT SUM(s.earmarked_luna) FROM personal_nim_savings s JOIN goals g ON g.id=s.goal_id WHERE s.user_id=? AND s.network=? AND s.address=? AND s.goal_id<>? AND g.purchased=0),0) <= ? OR EXISTS (SELECT 1 FROM personal_nim_savings WHERE goal_id=? AND user_id=? AND network=? AND address=? AND earmarked_luna>=?) " +
        "ON CONFLICT(goal_id,user_id,network) DO UPDATE SET address=excluded.address,target_luna=excluded.target_luna,earmarked_luna=excluded.earmarked_luna,review_date=excluded.review_date,purchase_date=CASE WHEN ? THEN excluded.purchase_date ELSE personal_nim_savings.purchase_date END,final_contribution_luna=CASE WHEN ? THEN excluded.final_contribution_luna ELSE personal_nim_savings.final_contribution_luna END,schedule_usd_rate=COALESCE(excluded.schedule_usd_rate,personal_nim_savings.schedule_usd_rate) WHERE personal_nim_savings.schedule_usd_rate IS NULL OR (excluded.schedule_usd_rate IS NOT NULL AND ? = 0)",
    )
      .bind(
        goalId,
        user.id,
        network,
        savings.address,
        savings.targetLuna,
        savings.earmarkedLuna,
        savings.reviewDate,
        savings.purchaseDate ?? null,
        savings.finalContributionLuna ?? 0,
        rate,
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
        Number(savings.purchaseDate !== undefined),
        Number(savings.finalContributionLuna !== undefined),
        Number(automaticLink),
      )
      .run();
    if (automaticLink && result.meta.changes === 0) {
      const linkedRecord = await env.DB.prepare(
        "SELECT 1 FROM personal_nim_savings WHERE goal_id=? AND user_id=? AND network=? AND address=? AND schedule_usd_rate IS NOT NULL",
      )
        .bind(goalId, user.id, network, savings.address)
        .first();
      if (linkedRecord) return json({ ok: true });
    }
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
