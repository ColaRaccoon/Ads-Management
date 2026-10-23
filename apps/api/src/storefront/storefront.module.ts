import { Module } from "@nestjs/common";
import { StorefrontController } from "./storefront.controller";
import { StorefrontReadService } from "./storefront-read.service";
import { StorefrontControlService } from "./storefront-control.service";
@Module({ controllers: [StorefrontController], providers: [StorefrontReadService, StorefrontControlService] })
export class StorefrontModule {}
