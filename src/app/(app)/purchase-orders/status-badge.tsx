import { Badge } from "@/components/ui/badge";
import {
  PURCHASE_ORDER_STATUS_LABELS,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/status";

const VARIANTS = {
  draft: "outline",
  ordered: "default",
  received: "secondary",
  cancelled: "destructive",
} as const satisfies Record<PurchaseOrderStatus, string>;

/** 発注のステータスの表示 */
export function PurchaseOrderStatusBadge({
  status,
}: {
  status: PurchaseOrderStatus;
}) {
  return (
    <Badge variant={VARIANTS[status]}>
      {PURCHASE_ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}
