import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Account } from "@/types";

export function AccountSelector({
  accounts,
  selectedAccountId,
  switchingAccount,
  onAccountChange,
  triggerClassName,
  contentAlign,
}: {
  accounts: Account[];
  selectedAccountId: string;
  switchingAccount: boolean;
  onAccountChange: (value: string) => void;
  triggerClassName?: string;
  contentAlign?: "start" | "center" | "end";
}) {
  return (
    <Select
      value={selectedAccountId}
      onValueChange={onAccountChange}
      disabled={switchingAccount}
    >
      <SelectTrigger
        aria-label="계좌 선택"
        aria-busy={switchingAccount}
        aria-describedby={switchingAccount ? "account-switch-status" : undefined}
        className={triggerClassName}
      >
        <SelectValue />
        {switchingAccount ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : null}
      </SelectTrigger>
      <SelectContent align={contentAlign}>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
