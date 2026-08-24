import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { AUTH_CONFIG, AuthConfig } from "./auth/auth.config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const authConfig = app.get<AuthConfig>(AUTH_CONFIG);
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false
    })
  );
  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void
    ) {
      // Let auth endpoints return the stable ORIGIN_NOT_ALLOWED response while
      // withholding the browser's CORS grant. A plain callback Error becomes
      // an unstructured 500 before the auth security service can run.
      callback(null, !origin || authConfig.allowedOrigins.has(origin));
    },
    credentials: true
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
}

void bootstrap();
