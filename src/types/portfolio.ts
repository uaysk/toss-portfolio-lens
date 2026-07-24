export type Account = {
  id: string;
  name: string;
  label: string;
  type: string;
};

export type Holding = {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  quantity: number;
  availableQuantity: number;
  averagePrice: number;
  currentPrice: number;
  purchaseAmount: number;
  evaluationAmount: number;
  profitLoss: number;
  profitRate: number;
  dailyProfitLoss: number;
  dailyProfitRate: number;
};

export type CurrencyAmounts = {
  KRW: number;
  USD: number;
};

export type Portfolio = {
  asOf: string;
  accounts: Account[];
  selectedAccountId: string;
  account: Account;
  summary: {
    evaluationAmount: CurrencyAmounts;
    purchaseAmount: CurrencyAmounts;
    profitLoss: CurrencyAmounts;
    dailyProfitLoss: CurrencyAmounts;
    profitRate: number;
    dailyProfitRate: number;
    positionCount: number;
  };
  holdings: Holding[];
};
