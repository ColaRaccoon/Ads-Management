/** Closed diagnostics only: never serialize an exception, message, request or identifier. */
import { Prisma } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { ProviderFailure } from './bounded-request';
import { META_MCP_WIRE_CODES, MetaMcpWireFailure } from './meta-mcp-wire-reader';
export const META_FAILURE_STAGES=['META_BINDING','META_FETCH','META_NORMALIZE','META_PUBLISH'] as const;
export type MetaFailureStage=typeof META_FAILURE_STAGES[number];
const PRISMA_CODES=['P1000','P1001','P1002','P1008','P1011','P1017','P2000','P2002','P2003','P2009','P2010','P2021','P2022','P2023','P2024','P2028','P2034'] as const;
type Kind=`PRISMA_${typeof PRISMA_CODES[number]}`|`WIRE_${typeof META_MCP_WIRE_CODES[number]}`|'PRISMA_VALIDATION'|'PROVIDER'|'HTTP'|'OTHER';
export type MetaFailureDiagnosticCode=`${MetaFailureStage}_${Kind}`;
const stages=new WeakMap<object,MetaFailureStage>();
export function markMetaFailureStage(error:unknown,stage:MetaFailureStage):void {
 if(error!==null&&(typeof error==='object'||typeof error==='function')&&META_FAILURE_STAGES.includes(stage))stages.set(error,stage);
}
export function safeMetaRuntimeFailureDiagnostic(error:unknown,fallback:MetaFailureStage):MetaFailureDiagnosticCode {
 const safeFallback=META_FAILURE_STAGES.includes(fallback)?fallback:'META_BINDING';
 const stage=error!==null&&(typeof error==='object'||typeof error==='function')?stages.get(error)??safeFallback:safeFallback;
 let kind:Kind='OTHER';
 if(error instanceof MetaMcpWireFailure&&typeof error.safeCode==='string'&&META_MCP_WIRE_CODES.includes(error.safeCode))kind=`WIRE_${error.safeCode}`;
 else if(error instanceof Prisma.PrismaClientKnownRequestError&&typeof error.code==='string'&&(PRISMA_CODES as readonly string[]).includes(error.code))kind=`PRISMA_${error.code as typeof PRISMA_CODES[number]}`;
 else if(error instanceof Prisma.PrismaClientInitializationError&&typeof error.errorCode==='string'&&(PRISMA_CODES as readonly string[]).includes(error.errorCode))kind=`PRISMA_${error.errorCode as typeof PRISMA_CODES[number]}`;
 else if(error instanceof Prisma.PrismaClientValidationError)kind='PRISMA_VALIDATION';
 else if(error instanceof ProviderFailure)kind='PROVIDER';
 else if(error instanceof HttpException)kind='HTTP';
 return `${stage}_${kind}`;
}
