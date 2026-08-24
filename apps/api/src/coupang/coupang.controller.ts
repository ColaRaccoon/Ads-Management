import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFile, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { CoupangService } from "./coupang.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller("coupang")
export class CoupangController {
  constructor(private readonly coupangService: CoupangService) {}

  @Post("uploads/sales")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadSales(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importSalesXlsx(file, body, actor.id);
  }

  @Post("uploads/ads")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadAds(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importAdsXlsx(file, body, actor.id);
  }

  @Post("uploads/margin")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadMargin(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importMarginCsv(file, body, actor.id);
  }

  @Post("uploads/price-text")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadPriceText(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importPriceText(file, body, actor.id);
  }

  @Post("uploads/promotion")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadPromotion(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importPromotionXlsx(file, body, actor.id);
  }

  @Post("uploads/bundle")
  @RequirePermissions("imports.manage")
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
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importBundle(files, body, actor.id);
  }

  @Get("uploads")
  @RequirePermissions("data.read")
  listUploads(@Query("take") take?: string) {
    return this.coupangService.listUploads(take ? Number(take) : 50);
  }

  @Get("uploads/:id/preview")
  @RequirePermissions("data.read")
  previewUpload(@Param("id") id: string, @Query("take") take?: string) {
    return this.coupangService.previewUpload(id, take ? Number(take) : 50);
  }

  @Get("uploads/:id/errors")
  @RequirePermissions("data.read")
  uploadErrors(@Param("id") id: string) {
    return this.coupangService.uploadErrors(id);
  }

  @Delete("uploads/:id")
  @RequirePermissions("imports.manage")
  deleteUpload(@Param("id") id: string) {
    return this.coupangService.deleteUpload(id);
  }

  @Get("product-settings")
  @RequirePermissions("data.read")
  listProductSettings(@Query("includeInactive") includeInactive?: string, @Query("date") date?: string) {
    return this.coupangService.listProductSettings(includeInactive === "true", date);
  }

  @Post("product-settings")
  @RequirePermissions("products.manage")
  createProductSetting(@Body() body: Record<string, unknown>) {
    return this.coupangService.createProductSetting(body);
  }

  @Patch("product-settings/:id/configuration")
  @RequirePermissions("products.manage")
  updateProductConfiguration(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.updateProductConfiguration(id, body);
  }

  @Patch("product-settings/:productId/cost-rules/:costRuleId")
  @RequirePermissions("products.manage")
  correctProductCostRule(
    @Param("productId") productId: string,
    @Param("costRuleId") costRuleId: string,
    @Body() body: Record<string, unknown>
  ) {
    return this.coupangService.correctProductCostRule(productId, costRuleId, body);
  }

  @Get("sales-fee-rules/current")
  @RequirePermissions("data.read")
  currentSalesFeeRule(@Query("date") date?: string) {
    return this.coupangService.currentSalesFeeRule(date);
  }

  @Get("sales-fee-rules")
  @RequirePermissions("data.read")
  listSalesFeeRules() {
    return this.coupangService.listSalesFeeRules();
  }

  @Post("sales-fee-rules")
  @RequirePermissions("products.manage")
  createSalesFeeRule(@Body() body: Record<string, unknown>) {
    return this.coupangService.createSalesFeeRule(body);
  }

  @Patch("sales-fee-rules/:id")
  @RequirePermissions("products.manage")
  correctSalesFeeRule(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.correctSalesFeeRule(id, body);
  }

  @Patch("product-settings/:id")
  @RequirePermissions("products.manage")
  updateProductSetting(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.updateProductSetting(id, body);
  }

  @Delete("product-settings/:id")
  @RequirePermissions("products.manage")
  deleteProductSetting(@Param("id") id: string) {
    return this.coupangService.deleteProductSetting(id);
  }

  @Get("product-groups")
  @RequirePermissions("data.read")
  listProductGroups(@Query("includeInactive") includeInactive?: string) {
    return this.coupangService.listProductGroups(includeInactive === "true");
  }

  @Post("product-groups")
  @RequirePermissions("products.manage")
  createProductGroup(@Body() body: Record<string, unknown>) {
    return this.coupangService.createProductGroup(body);
  }

  @Patch("product-groups/:id")
  @RequirePermissions("products.manage")
  updateProductGroup(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.updateProductGroup(id, body);
  }

  @Delete("product-groups/:id")
  @RequirePermissions("products.manage")
  deleteProductGroup(@Param("id") id: string) {
    return this.coupangService.deleteProductGroup(id);
  }

  @Get("mapping-rules")
  @RequirePermissions("data.read")
  listMappingRules(@Query("includeInactive") includeInactive?: string) {
    return this.coupangService.listMappingRules(includeInactive === "true");
  }

  @Post("mapping-rules")
  @RequirePermissions("mappings.manage")
  createMappingRule(@Body() body: Record<string, unknown>) {
    return this.coupangService.createMappingRule(body);
  }

  @Patch("mapping-rules/:id")
  @RequirePermissions("mappings.manage")
  updateMappingRule(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.updateMappingRule(id, body);
  }

  @Delete("mapping-rules/:id")
  @RequirePermissions("mappings.manage")
  deleteMappingRule(@Param("id") id: string) {
    return this.coupangService.deleteMappingRule(id);
  }

  @Get("manual-purchases/options")
  @RequirePermissions("data.read")
  manualPurchaseOptions(@Query("date") date?: string) {
    return this.coupangService.manualPurchaseOptions({ date });
  }

  @Get("manual-purchases")
  @RequirePermissions("data.read")
  listManualPurchases(@Query("from") from?: string, @Query("to") to?: string) {
    return this.coupangService.listManualPurchases({ from, to });
  }

  @Put("manual-purchases/:date")
  @RequirePermissions("operations.run")
  replaceManualPurchasesForDate(@Param("date") date: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.replaceManualPurchasesForDate(date, body);
  }

  @Delete("manual-purchases/:id")
  @RequirePermissions("operations.run")
  deleteManualPurchase(@Param("id") id: string) {
    return this.coupangService.deleteManualPurchase(id);
  }

  @Post("rematch")
  @RequirePermissions("mappings.manage")
  rematch(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.coupangService.rematch({ from, to, take });
  }

  @Get("dashboard")
  @RequirePermissions("data.read")
  dashboard(@Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") groupBy?: string) {
    return this.coupangService.dashboard({ from, to, groupBy });
  }

  @Get("product-profit")
  @RequirePermissions("data.read")
  productProfit(@Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") groupBy?: string) {
    return this.coupangService.productProfit({ from, to, groupBy });
  }

  @Get("ads-analysis")
  @RequirePermissions("data.read")
  adsAnalysis(@Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") groupBy?: string) {
    return this.coupangService.adsAnalysis({ from, to, groupBy });
  }

  @Get("unmatched")
  @RequirePermissions("data.read")
  unmatched(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.coupangService.unmatched({ from, to, take });
  }

  @Get("mapping-issues")
  @RequirePermissions("data.read")
  mappingIssues(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.coupangService.mappingIssues({ from, to, take });
  }

  @Get("daily-report")
  @RequirePermissions("data.read")
  dailyReport(
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("includeUncategorized") includeUncategorized?: string,
    @Query("q") q?: string
  ) {
    return this.coupangService.dailyReport({ date, from, to, categoryIds, includeUncategorized, q });
  }

  @Get("daily-report/categories")
  @RequirePermissions("data.read")
  listDailyReportCategories(@Query("includeInactive") includeInactive?: string) {
    return this.coupangService.listDailyReportCategories(includeInactive === "true");
  }

  @Get("daily-report/category-catalog")
  @RequirePermissions("data.read")
  dailyReportCategoryCatalog(@Query("includeInactive") includeInactive?: string) {
    return this.coupangService.dailyReportCategoryCatalog(includeInactive === "true");
  }

  @Post("daily-report/categories")
  @RequirePermissions("products.manage")
  createDailyReportCategory(@Body() body: Record<string, unknown>) {
    return this.coupangService.createDailyReportCategory(body);
  }

  @Patch("daily-report/categories/:id")
  @RequirePermissions("products.manage")
  updateDailyReportCategory(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.updateDailyReportCategory(id, body);
  }

  @Put("daily-report/categories/:id/products")
  @RequirePermissions("products.manage")
  replaceDailyReportCategoryProducts(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.coupangService.replaceDailyReportCategoryProducts(id, body);
  }

  @Delete("daily-report/categories/:id")
  @RequirePermissions("products.manage")
  deleteDailyReportCategory(@Param("id") id: string) {
    return this.coupangService.deleteDailyReportCategory(id);
  }
}
