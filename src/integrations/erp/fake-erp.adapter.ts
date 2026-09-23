import type { Pool } from "pg";
import type { Config } from "../../app/config.js";
import type { Metrics } from "../../observability/metrics.js";
import { withSpan } from "../../observability/tracing.js";

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  available: number;
  updatedAt: string;
}

interface CatalogRow {
  id: string;
  name: string;
  price_cents: number;
  available: number;
  updated_at: Date;
}

export class ErpTimeoutError extends Error {}
export class ErpPermanentError extends Error {}

export class FakeErpAdapter {
  constructor(
    private readonly database: Pool,
    private readonly config: Config,
    private readonly metrics: Metrics,
  ) {}

  async fetchCatalog(): Promise<CatalogProduct[]> {
    return withSpan("erp.catalog.fetch", async () => {
      this.metrics.erpRequests.inc();
      const stopTimer = this.metrics.catalogLoad.startTimer();
      try {
        if (this.config.ERP_CATALOG_MODE === "error")
          throw new Error("Fake ERP catalog unavailable");
        if (this.config.ERP_CATALOG_MODE === "slow") {
          await this.delay(this.config.ERP_TIMEOUT_MS + 100);
          throw new Error("Fake ERP catalog timed out");
        }
        const result = await this.database.query<CatalogRow>(
          `SELECT p.id, p.name, p.price_cents, i.available,
                  GREATEST(p.source_updated_at, i.updated_at) AS updated_at
           FROM products p JOIN inventory i ON i.product_id = p.id ORDER BY p.id`,
        );
        return result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          price: row.price_cents / 100,
          available: row.available,
          updatedAt: row.updated_at.toISOString(),
        }));
      } catch (error) {
        this.metrics.erpErrors.inc();
        throw error;
      } finally {
        stopTimer();
      }
    });
  }

  async invoice(orderId: string): Promise<string> {
    return withSpan("erp.invoice", async () => {
      this.metrics.erpRequests.inc();
      const stopTimer = this.metrics.erpDuration.startTimer();
      try {
        const existing = await this.lookupInvoice(orderId);
        if (existing) return existing;
        switch (this.config.ERP_BILLING_MODE) {
          case "error":
            throw new ErpPermanentError("Fake ERP rejected invoice");
          case "timeout":
            await this.delay(this.config.ERP_TIMEOUT_MS);
            throw new ErpTimeoutError("Fake ERP timed out");
          case "slow":
            await this.delay(this.config.ERP_TIMEOUT_MS + 100);
            throw new ErpTimeoutError("Fake ERP timed out");
          case "normal":
          case "accept_then_timeout": {
            const reference = `erp_${orderId}`;
            await this.database.query(
              `INSERT INTO erp_invoices (order_id, erp_reference)
               VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`,
              [orderId, reference],
            );
            if (this.config.ERP_BILLING_MODE === "accept_then_timeout") {
              throw new ErpTimeoutError(
                "ERP accepted invoice but response was lost",
              );
            }
            return reference;
          }
        }
      } catch (error) {
        this.metrics.erpErrors.inc();
        throw error;
      } finally {
        stopTimer();
      }
    });
  }

  async lookupInvoice(orderId: string): Promise<string | null> {
    const result = await this.database.query<{ erp_reference: string }>(
      "SELECT erp_reference FROM erp_invoices WHERE order_id = $1",
      [orderId],
    );
    return result.rows[0]?.erp_reference ?? null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
