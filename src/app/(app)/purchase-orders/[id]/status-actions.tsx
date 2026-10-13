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
  targets,
}: {
  id: number;
  number: string;
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
  to,
  onDone,
}: {
  id: number;
  number: string;
  to: Target;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const { action, question, description } =
    PURCHASE_ORDER_TRANSITION_LABELS[to];
  const destructive = to === "cancelled";

  function submit() {
    setError(undefined);
    startTransition(async () => {
      const result = await changePurchaseOrderStatusAction(id, to);
      if (result.ok) {
        setOpen(false);
        onDone();
      } else {
        setError(result.error);
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
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
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
