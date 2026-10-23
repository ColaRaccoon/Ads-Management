import {Prisma} from '@prisma/client';
export function compareLiveColumns(rows){
 if(!Array.isArray(rows)||rows.length>5000||rows.some(r=>typeof r.table!=='string'||typeof r.column!=='string'||!/^[a-z][a-z0-9_]*$/.test(r.table)||!/^[a-z][a-z0-9_]*$/.test(r.column)))throw Error('SCHEMA_METADATA_REJECTED');
 const found=new Set(rows.map(r=>r.table+'.'+r.column)),missing=[];
 for(const model of Prisma.dmmf.datamodel.models)for(const field of model.fields.filter(f=>f.kind!=='object')){
  const name=(model.dbName??model.name)+'.'+(field.dbName??field.name);if(!found.has(name))missing.push(name);
 }
 return {state:'PHASE08_SCHEMA_COLUMN_COMPARISON',expectedModels:Prisma.dmmf.datamodel.models.length,observedColumns:found.size,missingCount:missing.length,missing:missing.slice(0,50),databaseWrites:0,providerRequests:0};
}
if(process.argv[1]?.endsWith('compare-live-columns.mjs')){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>262144)throw Error('BOUND');}process.stdout.write(JSON.stringify(compareLiveColumns(JSON.parse(raw).rows)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_SCHEMA_COMPARISON_FAILED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}}
