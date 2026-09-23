import { randomUUID } from "node:crypto";

const base = process.env.API_URL ?? "http://localhost:3000";
const products = await fetch(`${base}/products`);
if (!products.ok) throw new Error(`GET /products failed: ${products.status}`);
const catalog = (await products.json()) as { items: Array<{ id: string }> };
const product = catalog.items[0];
if (!product) throw new Error("Catalog is empty; run npm run db:seed");

const checkout = await fetch(`${base}/checkout`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": randomUUID(),
  },
  body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
});
if (checkout.status !== 202)
  throw new Error(
    `POST /checkout failed: ${checkout.status} ${await checkout.text()}`,
  );
const order = (await checkout.json()) as { orderId: string };

for (let attempt = 0; attempt < 20; attempt++) {
  const response = await fetch(`${base}/orders/${order.orderId}/status`);
  if (!response.ok)
    throw new Error(`GET order status failed: ${response.status}`);
  const status = (await response.json()) as { status: string };
  if (
    ["COMPLETED", "FAILED", "RECONCILIATION_REQUIRED"].includes(status.status)
  ) {
    process.stdout.write(`${order.orderId}: ${status.status}\n`);
    if (status.status !== "COMPLETED") process.exitCode = 1;
    break;
  }
  if (attempt === 19)
    throw new Error(`Order ${order.orderId} did not reach a terminal state`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
