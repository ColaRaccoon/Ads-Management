export type Cafe24LiveInputCounts={totalOrderOrders:number;paidOrders:number;paymentMethodOrders:number;couponSignalOrders:number;productNameOrders:number};
const fields=["couponSignalOrders","paidOrders","paymentMethodOrders","productNameOrders","totalOrderOrders"] as const;
export function reviewCafe24LiveInputCounts(observed:Cafe24LiveInputCounts,reviewed:unknown) {
  if(!reviewed || typeof reviewed!=="object" || Array.isArray(reviewed) || Object.keys(reviewed).sort().join(",")!==fields.join(","))throw new Error("ISOLATED_REVIEWED_INPUT_EVIDENCE_REQUIRED");
  const expected=reviewed as Record<string,unknown>;
  for(const field of fields) {
    const count=observed[field];
    if(!Number.isSafeInteger(count)||count<0||count>422)throw new Error("ISOLATED_REVIEWED_INPUT_EVIDENCE_CHANGED");
    if((field==="couponSignalOrders"||field==="productNameOrders")&&expected[field]===null) {
      if(count<1||count>9)throw new Error("ISOLATED_REVIEWED_INPUT_EVIDENCE_CHANGED");
    }else if(!Number.isSafeInteger(expected[field])||expected[field]!==count)throw new Error("ISOLATED_REVIEWED_INPUT_EVIDENCE_CHANGED");
  }
}
export function suppressCafe24LiveInputCounts(observed:Cafe24LiveInputCounts) {
  return {...observed,couponSignalOrders:observed.couponSignalOrders>0&&observed.couponSignalOrders<10?null:observed.couponSignalOrders,
    productNameOrders:observed.productNameOrders>0&&observed.productNameOrders<10?null:observed.productNameOrders};
}
