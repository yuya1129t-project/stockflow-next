import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { suggestPartnerCodes } from "@/lib/partners/queries";
import { emptyPartnerForm } from "@/lib/partners/schema";

import { createPartnerAction } from "../actions";
import { PartnerForm } from "../partner-form";

export const metadata: Metadata = { title: "取引先の登録 | StockFlow" };

/** 取引先の登録（admin／staff）。spec §2 */
export default async function NewPartnerPage() {
  await requirePermission("master:edit");
  const suggestions = await suggestPartnerCodes(getPrisma());
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/partners"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 取引先一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">取引先の登録</h1>
      </div>
      <PartnerForm
        defaultValues={emptyPartnerForm("customer", suggestions.customer)}
        codeSuggestions={suggestions}
        submitLabel="登録する"
        cancelHref="/partners"
        action={createPartnerAction}
      />
    </div>
  );
}
