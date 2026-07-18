import { createHmac } from "node:crypto";
import type { PortfolioBacktestService } from "../backtest.js";
import type { TossClient } from "../toss.js";
import { ServiceError } from "./service-envelope.js";

export class PortfolioService {
  constructor(
    private readonly toss: TossClient,
    private readonly backtest: PortfolioBacktestService,
    private readonly selectorSecret: string,
  ) {}

  private selector(accountId: string): string {
    return `acct_${createHmac("sha256", this.selectorSecret).update(accountId).digest("base64url").slice(0, 32)}`;
  }

  async current(accountSelector?: string) {
    const accounts = await this.toss.getAccounts(false);
    if (!accounts.length) throw new ServiceError({ code: "NO_ACCOUNT", message: "조회 가능한 계좌가 없습니다.", retryable: false });
    const selected = accountSelector
      ? accounts.find((account) => this.selector(account.id) === accountSelector)
      : accounts[0];
    if (!selected) throw new ServiceError({ code: "ACCOUNT_SELECTOR_NOT_FOUND", message: "opaque account selector를 찾을 수 없습니다.", retryable: false });
    const portfolio = await this.backtest.currentPortfolio(selected.id);
    return {
      account_selector: this.selector(selected.id),
      available_accounts: accounts.map((account) => ({ account_selector: this.selector(account.id) })),
      base_currency: "KRW",
      assets: portfolio.assets.map((asset) => ({
        symbol: asset.symbol,
        name: asset.name,
        market: asset.market,
        currency: asset.currency,
        weight_percent: asset.weight,
      })),
      generated_at: new Date().toISOString(),
    };
  }
}
