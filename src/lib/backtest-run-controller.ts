export type BacktestExecutionContext = {
  strategyMode: "allocation" | "technical_signal";
  fingerprint: string;
};

export type BacktestRunToken = {
  generation: number;
  context: BacktestExecutionContext;
};

function sameContext(left: BacktestExecutionContext, right: BacktestExecutionContext): boolean {
  return left.strategyMode === right.strategyMode && left.fingerprint === right.fingerprint;
}

export class BacktestRunController {
  private generation = 0;
  private context: BacktestExecutionContext;

  constructor(initialContext: BacktestExecutionContext) {
    this.context = initialContext;
  }

  updateContext(context: BacktestExecutionContext): void {
    this.context = context;
  }

  begin(): BacktestRunToken {
    return {
      generation: ++this.generation,
      context: { ...this.context },
    };
  }

  accepts(token: BacktestRunToken): boolean {
    return token.generation === this.generation && sameContext(token.context, this.context);
  }

  isLatest(token: BacktestRunToken): boolean {
    return token.generation === this.generation;
  }
}
