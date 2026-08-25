import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { AUTH_CONFIG, AuthConfig } from "./auth/auth.config";
import {
  HTTP_SECURITY_CONFIG,
  HttpSecurityConfig
} from "./common/http-security.config";
import { configureHttpServer } from "./common/http-server";
import { DangerousJsonKeysPipe } from "./validation/dangerous-json-keys.pipe";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  const authConfig = app.get<AuthConfig>(AUTH_CONFIG);
  const httpSecurityConfig = app.get<HttpSecurityConfig>(HTTP_SECURITY_CONFIG);
  configureHttpServer(app, authConfig, httpSecurityConfig);
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new DangerousJsonKeysPipe(),
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false }
    })
  );

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
}

void bootstrap();
