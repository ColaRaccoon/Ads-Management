import { Module } from "@nestjs/common";
import { GoogleController } from "./google.controller";
import { GoogleReadService } from "./google-read.service";
import { GoogleMappingsService } from "./google-mappings.service";
@Module({ controllers: [GoogleController], providers: [GoogleReadService, GoogleMappingsService] })
export class GoogleModule {}
