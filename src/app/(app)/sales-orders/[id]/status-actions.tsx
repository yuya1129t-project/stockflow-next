"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toShortageRows, type ShortageRow } from "@/lib/sales-orders/shortages";
import {
  SALES_ORDER_TRANSITION_LABELS,
  type SalesOrderStatus,
} from "@/lib/sales-orders/status";

import { changeSalesOrderStatusAction } from "../actions";

type Target = Exclude<SalesOrderStatus, "draft">;

/**
 * ステータス変更のボタンと確認ダイアログ（admin／staff のみ表示。遷移の可否と権限はサーバー側でも検査する）
 */
export function SalesOrderStatusActions({
  id,
  number,
  updatedAt,
  targets,
}: {
  id: number;
  number: string;
  /** 詳細画面に表示した時点の updatedAt（ISO 8601）。サーバーで今の値と比べ、変わっていれば変更しない */
  updatedAt: string;
  /** 今のステータスから進めるステータス */
  targets: readonly Target[];
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap gap-2">
      {targets.map((to) => (
        <StatusButton
          key={to}
          id={id}
          number={number}
          updatedAt={updatedAt}
          to={to}
          // 結果の表示は詳細画面のメッセージで行う（最新の状態を読み直す）
          onDone={() => router.replace(`/sales-orders/${id}?saved=${to}`)}
        />
      ))}
    </div>
  );
}

function StatusButton({
  id,
  number,
  updatedAt,
  to,
  onDone,
}: {
  id: number;
  number: string;
  updatedAt: string;
  to: Target;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<{
    message: string;
    conflict: boolean;
    /** 出荷で在庫が足りなかった商品（出荷はしていない） */
    shortages: ShortageRow[];
  }>();
  const [pending, startTransition] = useTransition();
  const { action, question, description } = SALES_ORDER_TRANSITION_LABELS[to];
  const destructive = to === "cancelled";

  function submit() {
    setError(undefined);
    startTransition(async () => {
      const result = await changeSalesOrderStatusAction(id, to, updatedAt);
      if (result.ok) {
        setOpen(false);
        onDone();
      } else {
        setError({
          message: result.error,
          conflict: result.conflict === true,
          shortages: toShortageRows(result.shortages ?? []),
        });
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setError(undefined);
      }}
    >
      <DialogTrigger
        render={<Button variant={destructive ? "destructive" : "default"} />}
      >
        {action}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            受注 {number} を{question}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>{error.message}</p>
            {error.shortages.length > 0 && (
              <ShortageTable rows={error.shortages} />
            )}
            {error.conflict && (
              // 再読み込みして最新の内容（明細・ステータス）を表示する
              <a
                href={`/sales-orders/${id}`}
                className="underline underline-offset-4"
              >
                最新の内容を表示する
              </a>
            )}
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            キャンセル
          </DialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={submit}
            disabled={pending}
          >
            {pending ? "処理中…" : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 在庫が足りない商品の一覧（必要数・現在庫・不足数） */
function ShortageTable({ rows }: { rows: ShortageRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-destructive/40">
      <table className="w-full text-xs">
        <caption className="sr-only">在庫が足りない商品</caption>
        <thead>
          <tr className="border-b border-destructive/40 text-left">
            <th scope="col" className="px-2 py-1 font-medium">
              商品
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              必要数
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              現在庫
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              不足数
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.productId} className="border-b last:border-0">
              <td className="px-2 py-1 break-words">{row.product}</td>
              <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                {row.required}
              </td>
              <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                {row.available}
              </td>
              <td className="px-2 py-1 text-right font-medium whitespace-nowrap tabular-nums">
                {row.shortage}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
