import { Channel3 } from "@channel3/sdk";
import { z } from "zod";
import { httpsUrl } from "../shared/domain";
import { insist, json, jsonBody, now, required, session } from "./http";
const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  images: z
    .array(
      z.object({
        url: z.string(),
        cleaned_url: z.string().nullish(),
        is_main_image: z.boolean().optional(),
      }),
    )
    .optional(),
  offers: z
    .array(
      z.object({
        url: z.string(),
        domain: z.string(),
        price: z.object({
          price: z.number().nonnegative(),
          currency: z.string(),
        }),
        availability: z.string(),
      }),
    )
    .optional(),
  variants: z.unknown().optional(),
});
export function normalizeProduct(input: unknown) {
  const p = productSchema.parse(input);
  const offers = (p.offers || []).flatMap((o) => {
    const url = httpsUrl(o.url),
      priceCents = Math.round(o.price.price * 100);
    return url && Number.isSafeInteger(priceCents) && priceCents > 0
      ? [
          {
            url,
            merchant: o.domain,
            priceCents,
            currency: o.price.currency,
            available: o.availability === "InStock",
          },
        ]
      : [];
  });
  const preferred = offers
    .filter((o) => o.currency === "USD" && o.available)
    .sort((a, b) => a.priceCents - b.priceCents)[0];
  const image = p.images?.find((i) => i.is_main_image) || p.images?.[0];
  return {
    id: p.id,
    title: p.title,
    imageUrl: image ? httpsUrl(image.cleaned_url || image.url) : null,
    offers,
    priceCents: preferred?.priceCents ?? null,
    currency: preferred?.currency ?? null,
    merchantUrl: preferred?.url ?? null,
    merchant: preferred?.merchant ?? null,
    available: !!preferred,
    variants: p.variants ?? null,
    observedAt: now(),
  };
}
export async function searchProducts(env: Env, query: string, userId: string) {
  required(env, ["CHANNEL3_API_KEY"]);
  const client = new Channel3({ apiKey: env.CHANNEL3_API_KEY });
  const page = await client.products.search(
    {
      query,
      limit: 12,
      config: { country: "US", currency: "USD" },
      "x-user-id": userId,
    },
    { timeoutInSeconds: 15, maxRetries: 0 },
  );
  const products = page.data.map(normalizeProduct);
  if (products.length)
    await env.DB.batch(
      products.map((p) =>
        env.DB.prepare(
          "INSERT INTO product_snapshots(id,payload,observed_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,observed_at=excluded.observed_at",
        ).bind(p.id, JSON.stringify(p), p.observedAt),
      ),
    );
  return products;
}
export async function products(
  r: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (!path.startsWith("/api/products/")) return null;
  const user = await session(r, env, r.method !== "GET");
  if (path === "/api/products/search" && r.method === "POST") {
    const v = z
      .object({ query: z.string().trim().min(2).max(400) })
      .parse(await jsonBody(r));
    return json({ products: await searchProducts(env, v.query, user.id) });
  }
  const match = path.match(/^\/api\/products\/([^/]+)$/);
  if (match && r.method === "GET") {
    required(env, ["CHANNEL3_API_KEY"]);
    const client = new Channel3({ apiKey: env.CHANNEL3_API_KEY });
    const product = normalizeProduct(
      await client.products.retrieve(
        {
          product_id: decodeURIComponent(match[1]),
          currency: "USD",
          country: "US",
          "x-user-id": user.id,
        },
        { timeoutInSeconds: 15, maxRetries: 0 },
      ),
    );
    insist(product, 404, "PRODUCT_NOT_FOUND", "Product not found.");
    await env.DB.prepare(
      "INSERT INTO product_snapshots(id,payload,observed_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,observed_at=excluded.observed_at",
    )
      .bind(product.id, JSON.stringify(product), now())
      .run();
    return json({ product });
  }
  return null;
}
