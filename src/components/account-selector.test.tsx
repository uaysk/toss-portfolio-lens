import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountSelector } from "./account-selector";

const accounts = [
  { id: "account-1", name: "주식", label: "주식 계좌", type: "stock" },
  { id: "account-2", name: "ISA", label: "ISA 계좌", type: "isa" },
];

describe("AccountSelector", () => {
  it("exposes the selected account as an accessible combobox", () => {
    const markup = renderToStaticMarkup(
      <AccountSelector
        accounts={accounts}
        selectedAccountId="account-2"
        switchingAccount={false}
        onAccountChange={() => undefined}
      />,
    );

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="계좌 선택"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).not.toContain("account-switch-status");
  });

  it("announces and disables the control while switching accounts", () => {
    const markup = renderToStaticMarkup(
      <AccountSelector
        accounts={accounts}
        selectedAccountId="account-1"
        switchingAccount
        onAccountChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-describedby="account-switch-status"');
    expect(markup).toContain("disabled");
  });
});
