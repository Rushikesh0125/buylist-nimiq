import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const origin = "http://localhost:8787";
const recipient = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const sender = "NQ05 U1RF QJNH JCS1 RDQX 4M3Y 60KR K6CN 5LKC";
const txHash = "ab".repeat(32);
const path = "/api/goals/shared/nimiq";
let mf: Miniflare;
let head = 121;
let network = "MainAlbatross";
let transfer: Record<string, unknown> | undefined;

function request(
  path: string,
  method: string,
  body?: unknown,
  cookie?: string,
) {
  return mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: ".wrangler/build/index.js",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: {
        APP_ORIGIN: origin,
        NIMIQ_RPC_URL: "https://rpc.example.test",
        NIMIQ_NETWORK: "mainnet",
      },
      outboundService: async (request) => {
        const { method, params } = (await request.json()) as {
          method: string;
          params: string[];
        };
        if (method === "getLatestBlock")
          return Response.json({ result: { data: { network, number: head } } });
        assert.equal(method, "getTransactionByHash");
        assert.equal(params[0], txHash);
        return Response.json(
          transfer
            ? { result: { data: transfer } }
            : {
                error: {
                  code: -32603,
                  message: "Internal error",
                  data: "Transaction not found: " + txHash,
                },
              },
        );
      },
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    const sql = await readFile("migrations/" + file, "utf8");
    for (const statement of sql.match(
      /CREATE TRIGGER[\s\S]*?END;|(?:ALTER TABLE|CREATE TABLE|CREATE (?:UNIQUE )?INDEX|PRAGMA)[^;]*;/g,
    ) || []) {
      await db.prepare(statement).run();
    }
  }
  for (const user of ["owner", "member", "outsider"]) {
    await db
      .prepare("INSERT INTO users VALUES(?,?,?, ?,0)")
      .bind(user, user, "", user)
      .run();
    await db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .bind(
        createHash("sha256").update(user).digest("hex"),
        user,
        "csrf",
        Math.floor(Date.now() / 1000) + 600,
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO goals(id,owner_id,name,target_cents,currency,mode,timezone,created_at) VALUES('shared','owner','Gift',10000,'USD','flexible','UTC',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO memberships VALUES ('shared','owner','owner',0),('shared','member','member',0)",
    )
    .run();
});
after(async () => {
  await mf?.dispose();
});

test("wallet login verifies the Nimiq signature, binds the nonce to the browser and rejects replay", async () => {
  const response = await request("/api/auth/nimiq/start", "POST", {});
  assert.equal(response.status, 200);
  const { message } = (await response.json()) as { message: string };
  const challenge = response.headers.getSetCookie()[0].split(";")[0];
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const digest = createHash("sha256")
    .update(
      "\x16Nimiq Signed Message:\n" + Buffer.byteLength(message) + message,
    )
    .digest();
  const proof = {
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex"),
    signature: sign(null, digest, privateKey).toString("hex"),
  };
  assert.equal(
    (await request("/api/auth/nimiq/verify", "POST", proof)).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/api/auth/nimiq/verify",
        "POST",
        { ...proof, signature: "00".repeat(64) },
        challenge,
      )
    ).status,
    401,
  );
  const verified = await request(
    "/api/auth/nimiq/verify",
    "POST",
    proof,
    challenge,
  );
  assert.equal(verified.status, 200);
  const session = verified.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-buylist="))!
    .split(";")[0];
  const signedIn = await request(
    "/api/auth/session",
    "GET",
    undefined,
    session,
  );
  assert.ok(((await signedIn.json()) as { user: unknown }).user);
  assert.equal(
    (await request("/api/auth/nimiq/verify", "POST", proof, challenge)).status,
    401,
  );
});

test("NIM contribution survives reload, requires matching finalized transfer and credits once", async () => {
  const owner = "__Host-buylist=owner",
    member = "__Host-buylist=member";
  const setup = { recipient, targetLuna: 500_000 };
  assert.equal(
    (await request(path, "GET", undefined, "__Host-buylist=outsider")).status,
    404,
  );
  assert.equal((await request(path, "PUT", setup, member)).status, 403);
  assert.equal(
    (
      await request(
        path,
        "PUT",
        { ...setup, recipient: recipient.replace("NQ26", "NQ25") },
        owner,
      )
    ).status,
    400,
  );
  assert.equal((await request(path, "PUT", setup, owner)).status, 201);
  assert.equal((await request(path, "PUT", setup, owner)).status, 409);

  const contribution = { amountLuna: 10_000, accounts: [sender] };
  const created = await request(path, "POST", contribution, member);
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await request(path, "POST", contribution, member)).status, 409);
  const verify = () => request(path + "/" + id, "POST", { txHash }, member);

  assert.equal((await verify()).status, 202);
  const pending = await (await request(path, "GET", undefined, member)).json();
  assert.deepEqual(pending, {
    enabled: true,
    config: { recipient, target_luna: 500_000, network: "mainnet" },
    confirmed: 0,
    pending: { id, amount_luna: 10_000, tx_hash: txHash },
  });

  transfer = {
    hash: txHash,
    from: sender,
    to: recipient,
    value: 10_000,
    recipientData: "00",
    executionResult: true,
    blockNumber: 121,
  };
  assert.equal((await verify()).status, 422);
  transfer.recipientData = Buffer.from(id).toString("hex");
  network = "TestAlbatross";
  assert.equal((await verify()).status, 502);
  network = "MainAlbatross";
  assert.equal((await verify()).status, 202);
  head = 180;
  const results = await Promise.all([verify(), verify()]);
  assert.deepEqual(
    results.map((response) => response.status),
    [200, 200],
  );
  const summary = (await (
    await request(path, "GET", undefined, owner)
  ).json()) as { confirmed: number };
  assert.equal(summary.confirmed, 10_000);
});
