import { IsBoolean, IsString, Matches } from "class-validator";
export class StorefrontQuery {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
}
export class StorefrontEnabledInput {
  @IsBoolean() enabled!: boolean;
  @IsString() @Matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) expectedUpdatedAt!: string;
}
