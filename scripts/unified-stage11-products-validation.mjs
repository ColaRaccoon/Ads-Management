import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Prisma} from '@prisma/client';
const dir='docs/product-performance/research/',read=file=>JSON.parse(readFileSync(dir+file,'utf8')),D=Prisma.Decimal;
const db=read('11-products-final-database.json').rows.verification,inspection=read('11-products-final-inspect.json'),old=read('11-products-inspect.json');
const delta=read('11-products-pullup-delta.json').rows.delta,ui=read('11-products-ui.json');
assert.equal(inspection.status,'PASS');
for(const field of ['expected','published','currentPointers'])assert.equal(db[field],830);
assert.equal(db.staging,0);assert.equal(db.activeProducts,124);assert.equal(db.rulesCount,48);assert.equal(db.audits,174);
const previous=old.samples.find(x=>x.productName==='풀업바'),current=inspection.samples.find(x=>x.productName==='풀업바');
assert.equal(previous.knownTotals.adSpend,current.knownTotals.adSpend);assert.deepEqual(previous.byMedium,current.byMedium);
for(const field of ['identityAddedOrRemoved','changedProductAssignment','changedSourcePayload','previousKnownRevenueChangedRows','previousKnownRevenueDelta','previousKnownProfitChangedRows','previousKnownProfitDelta'])assert.equal(delta[field],0);
assert(new D(current.knownTotals.revenue).minus(previous.knownTotals.revenue).equals(delta.newlyKnownRevenue));
assert(new D(current.knownTotals.profitBeforeAds).minus(previous.knownTotals.profitBeforeAds).equals(delta.newlyKnownProfit));
const running=inspection.samples.find(x=>x.productName==='러닝조끼');
assert(running.byMarketplace.every(x=>x.revenue!==null&&new D(x.revenue).gt(0)));
assert(new D(running.byMedium.find(x=>x.medium==='META').adSpend).gt(0));
assert.equal(ui.phase,'final');assert.equal(ui.status,'PASS');assert.equal(ui.staleConfiguration,false);
assert.equal(ui.cards[0].lineDots,30);assert.equal(ui.cards[1].lineDots,90);assert.equal(ui.cards[3].barPaths,3);
const evidence={status:'PASS',published:830,currentPointers:830,staging:0,activeProducts:124,rules:48,audits:174,
 pullup:{existingKnownRevenueAndProfitUnchanged:true,adSpendUnchanged:true,sourcePayloadAndAssignmentUnchanged:true,
  newlyKnownRevenueRows:delta.newlyKnownRows,newlyKnownRevenue:delta.newlyKnownRevenue,newlyKnownProfitRows:delta.newlyKnownProfitRows,newlyKnownProfit:delta.newlyKnownProfit,knownTotals:current.knownTotals},
 running:{knownTotals:running.knownTotals,marketplaces:running.byMarketplace,media:running.byMedium},
 ui:'Actual authenticated production browser; 30 day points / 90 income-profit points / 3 marketplaces; no configuration drift',sourceDml:0};
writeFileSync(dir+'11-products-final-validation.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({status:evidence.status,published:830,previousKnownAmountsChanged:0,newlyKnownPullupRevenue:delta.newlyKnownRevenue}));
