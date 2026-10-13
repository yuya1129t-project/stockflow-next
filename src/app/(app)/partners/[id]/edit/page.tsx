import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getPartner } from "@/lib/partners/queries";
import { toPartnerFormValues } from "@/lib/partners/schema";

import { updatePartnerAction } from "../../actions";
import { PartnerForm } from "../../partner-form";
import { parsePartnerId } from "../partner-id";

export const metadata: Metadata = { title: "取引先の編集 | StockFlow" };

/** 取引先の編集（admin／staff）。spec §2 */
export default async function EditPartnerPage({
  params,
}: PageProps<"/partners/[id]/edit">) {
  await requirePermission("master:edit");
  const id = parsePartnerId((await params).id);
  if (id === null) notFound();
  const partner = await getPartner(getPrisma(), id);
  if (!partner) notFound();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href={`/partners/${id}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 取引先の詳細
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          取引先の編集
          <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
            {partner.code}
          </span>
        </h1>
      </div>
      <PartnerForm
        defaultValues={toPartnerFormValues(partner)}
        submitLabel="保存する"
        cancelHref={`/partners/${id}`}
        action={updatePartnerAction.bind(null, id)}
      />
    </div>
  );
}
