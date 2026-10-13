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
import {
  PURCHASE_ORDER_TRANSITION_LABELS,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/status";

import { changePurchaseOrderStatusAction } from "../actions";

type Target = Exclude<PurchaseOrderStatus, "draft">;

/**
 * ステータス変更のボタンと確認ダイアログ（admin／staff のみ表示。遷移の可否と権限はサーバー側でも検査する）
 */
export function PurchaseOrderStatusActions({
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
          onDone={() => router.replace(`/purchase-orders/${id}?saved=${to}`)}
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
  const [error, setError] = useState<{ message: string; conflict: boolean }>();
  const [pending, startTransition] = useTransition();
  const { action, question, description } =
    PURCHASE_ORDER_TRANSITION_LABELS[to];
  const destructive = to === "cancelled";

  function submit() {
    setError(undefined);
    startTransition(async () => {
      const result = await changePurchaseOrderStatusAction(id, to, updatedAt);
      if (result.ok) {
        setOpen(false);
        onDone();
      } else {
        setError({ message: result.error, conflict: result.conflict === true });
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
            発注 {number} を{question}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>{error.message}</p>
            {error.conflict && (
              // 再読み込みして最新の内容（明細・ステータス）を表示する
              <a
                href={`/purchase-orders/${id}`}
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
