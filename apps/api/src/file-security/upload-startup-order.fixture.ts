import { Controller, Module, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { UPLOAD_PROFILES, uploadFileInterceptor } from "./upload-profiles";

@Controller("startup-upload-test")
export class StartupUploadTestController {
  static calls = 0;

  @Post()
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.META_CSV))
  upload(@UploadedFile() file: Express.Multer.File | undefined) {
    StartupUploadTestController.calls += 1;
    return { size: file?.size ?? 0 };
  }
}

@Module({ controllers: [StartupUploadTestController] })
export class StartupUploadTestModule {}
