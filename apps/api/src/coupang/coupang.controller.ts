import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { CoupangService } from "./coupang.service";

@Controller("coupang")
export class CoupangController {
  constructor(private readonly coupangService: CoupangService) {}

  @Post("uploads/sales")
  @UseInterceptors(FileInterceptor("file"))
  uploadSales(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.coupangService.importSalesXlsx(file, body);
  }

  @Post("uploads/ads")
  @UseInterceptors(FileInterceptor("file"))
  uploadAds(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.coupangService.importAdsXlsx(file, body);
  }

  @Post("uploads/margin")
  @UseInterceptors(FileInterceptor("file"))
  uploadMargin(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.coupangService.importMarginCsv(file, body);
  }

  @Post("uploads/price-text")
  @UseInterceptors(FileInterceptor("file"))
  uploadPriceText(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.coupangService.importPriceText(file, body);
  }

  @Post("uploads/promotion")
  @UseInterceptors(FileInterceptor("file"))
  uploadPromotion(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.coupangService.importPromotionXlsx(file, body);
  }

  @Post("uploads/bundle")
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: "sales", maxCount: 1 },
      { name: "ads", maxCount: 1 },
      { name: "margin", maxCount: 1 }
    ])
  )
  uploadBundle(
    @UploadedFiles()
    files: {
      sales?: Express.Multer.File[];
      ads?: Express.Multer.File[];
      margin?: Express.Multer.File[];
    },
    @Body() body: Record<string, unknown>
  ) {
    return this.coupangService.importBundle(files, body);
  }

  @Get("uploads")
  listUploads(@Query("take") take?: string) {
    return this.coupangService.listUploads(take ? Number(take) : 50);
  }

  @Get("uploads/:id/preview")
  previewUpload(@Param("id") id: string, @Query("take") take?: string) {
    return this.coupangService.previewUpload(id, take ? Number(take) : 50);
  }

  @Get("uploads/:id/errors")
  uploadErrors(@Param("id") id: string) {
    return this.coupangService.uploadErrors(id);
  }

  @Delete("uploads/:id")
  deleteUpload(@Param("id") id: string) {
    return this.coupangService.deleteUpload(id);
  }

  @Get("product-settings")
  listProductSettings(@Query("includeInactive") includeInactive?: string) {
    return this.coupangService.listProductSettings(includeInactive === "true");
  }

  @Post("product-settings")
  createProductSetting(@Body() body: Record<string, unknown>) {
    return this.coupangService.createProductSetting(body);
  }

  @Patch("product-settings/:id")
  updateProductSetting(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.updateProductSetting(id, body);
  }

  @Delete("product-settings/:id")
  deleteProductSetting(@Param("id") id: string) {
    return this.coupangService.deleteProductSetting(id);
  }

  @Post("rematch")
  rematch(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.coupangService.rematch({ from, to, take });
  }

  @Get("dashboard")
  dashboard(@Query("from") from?: string, @Query("to") to?: string) {
    return this.coupangService.dashboard({ from, to });
  }

  @Get("product-profit")
  productProfit(@Query("from") from?: string, @Query("to") to?: string) {
    return this.coupangService.productProfit({ from, to });
  }

  @Get("ads-analysis")
  adsAnalysis(@Query("from") from?: string, @Query("to") to?: string) {
    return this.coupangService.adsAnalysis({ from, to });
  }

  @Get("unmatched")
  unmatched(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.coupangService.unmatched({ from, to, take });
  }

  @Get("daily-report")
  dailyReport(@Query("date") date?: string) {
    return this.coupangService.dailyReport({ date });
  }
}
