import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
  SetMetadata
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, finalize } from "rxjs";
import { HTTP_SECURITY_CONFIG, HttpSecurityConfig } from "./http-security.config";

export const HEAVY_OPERATION_METADATA = "meta-ads:heavy-operation";

export const HeavyOperation = () => SetMetadata(HEAVY_OPERATION_METADATA, true);

export type HeavyOperationLease = { release: () => void };

@Injectable()
export class HeavyOperationGate implements NestInterceptor {
  private active = 0;

  constructor(
    @Inject(HTTP_SECURITY_CONFIG) private readonly config: HttpSecurityConfig,
    @Inject(Reflector) private readonly reflector: Reflector
  ) {}

  tryAcquire(): HeavyOperationLease | null {
    if (this.active >= this.config.heavyOperationConcurrency) return null;
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      }
    };
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const heavy = this.reflector.getAllAndOverride<boolean>(HEAVY_OPERATION_METADATA, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!heavy) return next.handle();

    const lease = this.tryAcquire();
    if (!lease) {
      const response = context.switchToHttp().getResponse<{ setHeader?: (name: string, value: string) => void }>();
      response?.setHeader?.("Retry-After", String(this.config.heavyOperationRetryAfterSeconds));
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "HEAVY_OPERATION_BUSY",
        message: "A memory-intensive operation is already running. Retry later."
      });
    }

    try {
      return next.handle().pipe(finalize(() => lease.release()));
    } catch (error) {
      lease.release();
      throw error;
    }
  }
}
