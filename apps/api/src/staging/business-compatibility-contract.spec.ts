import { describe, expect, it } from "vitest";
import { businessCompatibilityDigest } from "./business-compatibility-contract";

describe("business compatibility canonical contract",()=>{
  it("hashes complete values while normalizing object and row order",()=>{
    const left=businessCompatibilityDigest({products:[{id:"b",margin:2},{id:"a",margin:1}],summary:{spend:10,purchases:2}});
    const reordered=businessCompatibilityDigest({summary:{purchases:2,spend:10},products:[{margin:1,id:"a"},{margin:2,id:"b"}]});
    const changed=businessCompatibilityDigest({products:[{id:"b",margin:3},{id:"a",margin:1}],summary:{spend:10,purchases:2}});
    expect(left.digest).toBe(reordered.digest);expect(left.digest).not.toBe(changed.digest);expect(left.outputCapsVerified).toBe(true);
  });

  it("fails closed when the aggregate row cap is exceeded",()=>{
    expect(()=>businessCompatibilityDigest({rows:Array.from({length:100_001},(_,index)=>index)})).toThrow("BUSINESS_COMPATIBILITY_ARRAY_LIMIT");
  });
});
