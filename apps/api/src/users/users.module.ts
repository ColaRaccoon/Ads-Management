import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CommonModule } from "../common/common.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [CommonModule, AuthModule],
  controllers: [UsersController],
  providers: [UsersService]
})
export class UsersModule {}
