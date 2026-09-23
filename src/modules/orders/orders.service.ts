import type { Pool } from "pg";
import { HttpError } from "../../shared/errors.js";
import type { OrderStatus } from "../checkout/checkout.service.js";
import { withSpan } from "../../observability/tracing.js";

interface OrderRow {
  id: string;
  status: OrderStatus;
  updated_at: Date;
}

export class OrdersService {
  constructor(private readonly database: Pool) {}

  async getStatus(orderId: string) {
    return withSpan("orders.getStatus", async () => {
      const result = await this.database.query<OrderRow>(
        "SELECT id, status, updated_at FROM orders WHERE id = $1",
        [orderId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
      return {
        orderId: row.id,
        status: row.status,
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }
}
