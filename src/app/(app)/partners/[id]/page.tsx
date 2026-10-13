import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/guards";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/db";
import { getPartner } from "@/lib/partners/queries";
import {
  formatPostalCode,
  PARTNER_FIELD_LABELS,
  PARTNER_KIND_LABELS,
} from "@/lib/partners/schema";

import { PartnerActiveToggle } from "./active-toggle";
import { parsePartnerId } from "./partner-id";

export const metadata: Metadata = { title: "取引先の詳細 | StockFlow" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "取引先を登録しました",
  updated: "取引先を保存しました",
};

function orNone(value: string | null): ReactNode {
  return value ? (
    value
  ) : (
    <span className="text-muted-foreground">（未登録）</span>
  );
}

/** 取引先の詳細（全ロール閲覧可）。編集は admin／staff、無効化・再有効化は admin のみ */
export default async function PartnerDetailPage({
  params,
  searchParams,
}: PageProps<"/partners/[id]">) {
  const user = await requirePermission("view");
  const id = parsePartnerId((await params).id);
  if (id === null) notFound();
  const partner = await getPartner(getPrisma(), id);
  if (!partner) notFound();
  const saved = (await searchParams).saved;
  const savedMessage =
    typeof saved === "string" ? SAVED_MESSAGES[saved] : undefined;

  const rows: [string, ReactNode][] = [
    [
      PARTNER_FIELD_LABELS.code,
      <span key="code" className="font-mono">
        {partner.code}
      </span>,
    ],
    [PARTNER_FIELD_LABELS.name, partner.name],
    [PARTNER_FIELD_LABELS.kind, PARTNER_KIND_LABELS[partner.kind]],
    [
      PARTNER_FIELD_LABELS.postalCode,
      orNone(formatPostalCode(partner.postalCode) || null),
    ],
    [PARTNER_FIELD_LABELS.address, orNone(partner.address)],
    [PARTNER_FIELD_LABELS.phone, orNone(partner.phone)],
    [PARTNER_FIELD_LABELS.email, orNone(partner.email)],
    [
      "状態",
      partner.isActive ? (
        "有効"
      ) : (
        <Badge key="status" variant="outline">
          無効
        </Badge>
      ),
    ],
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/partners"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 取引先一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{partner.name}</h1>
      </div>

      {savedMessage && (
        <p
          role="status"
          className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm"
        >
          {savedMessage}
        </p>
      )}

      <dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        {can(user.role, "master:edit") && (
          <Link
            href={`/partners/${partner.id}/edit`}
            className={buttonVariants()}
          >
            編集する
          </Link>
        )}
        {can(user.role, "master:deactivate") && (
          <PartnerActiveToggle
            id={partner.id}
            code={partner.code}
            name={partner.name}
            isActive={partner.isActive}
          />
        )}
      </div>
    </div>
  );
}
