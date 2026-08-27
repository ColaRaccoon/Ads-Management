import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFile, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { CoupangService } from "./coupang.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { SecureCoupangBundlePipe, SecureUploadPipe } from "../file-security/secure-upload.pipe";
import { coupangBundleInterceptor, UPLOAD_PROFILES, uploadFileInterceptor } from "../file-security/upload-profiles";
import {
  CoupangBundleUploadFormDto,
  CoupangCostRuleCorrectionDto,
  CoupangCreateProductSettingDto,
  CoupangDailyReportQueryDto,
  CoupangGroupQueryDto,
  CoupangIdParamDto,
  CoupangIncludeInactiveQueryDto,
  CoupangManualPurchaseDateParamDto,
  CoupangManualPurchaseOptionsQueryDto,
  CoupangManualPurchasesBodyDto,
  CoupangManualPurchasesQueryDto,
  CoupangMappingRuleDto,
  CoupangMarginUploadFormDto,
  CoupangProductCostParamDto,
  CoupangProductGroupDto,
  CoupangProductSettingsQueryDto,
  CoupangProductSettingDto,
  CoupangRematchQueryDto,
  CoupangSalesFeeRuleDto,
  CoupangSalesUploadFormDto,
  CreateCoupangDailyReportCategoryDto,
  ReplaceCoupangDailyReportCategoryProductsDto,
  UpdateCoupangDailyReportCategoryDto,
  CoupangUnmatchedQueryDto,
  CoupangUploadFormDto,
  CoupangUploadListQueryDto,
  CoupangUploadPreviewQueryDto
} from "./dto/coupang-transport.dto";

@Controller("coupang")
export class CoupangController {
  constructor(private readonly coupangService: CoupangService) {}

  @Post("uploads/sales")
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.COUPANG_SALES_XLSX))
  uploadSales(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.COUPANG_SALES_XLSX)) file: Express.Multer.File,
    @Body() body: CoupangSalesUploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importSalesXlsx(file, body, actor.id);
  }

  @Post("uploads/ads")
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.COUPANG_ADS_XLSX))
  uploadAds(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.COUPANG_ADS_XLSX)) file: Express.Multer.File,
    @Body() body: CoupangUploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importAdsXlsx(file, body, actor.id);
  }

  @Post("uploads/margin")
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.COUPANG_MARGIN_TEXT))
  uploadMargin(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.COUPANG_MARGIN_TEXT)) file: Express.Multer.File,
    @Body() body: CoupangMarginUploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importMarginCsv(file, body, actor.id);
  }

  @Post("uploads/price-text")
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.COUPANG_PRICE_TEXT))
  uploadPriceText(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.COUPANG_PRICE_TEXT)) file: Express.Multer.File,
    @Body() body: CoupangMarginUploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importPriceText(file, body, actor.id);
  }

  @Post("uploads/promotion")
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.COUPANG_PROMOTION_XLSX))
  uploadPromotion(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.COUPANG_PROMOTION_XLSX)) file: Express.Multer.File,
    @Body() body: CoupangUploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importPromotionXlsx(file, body, actor.id);
  }

  @Post("uploads/bundle")
  @RequirePermissions("imports.manage")
  @UseInterceptors(coupangBundleInterceptor())
  uploadBundle(
    @UploadedFiles(new SecureCoupangBundlePipe())
    files: {
      sales?: Express.Multer.File[];
      ads?: Express.Multer.File[];
      margin?: Express.Multer.File[];
    },
    @Body() body: CoupangBundleUploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.importBundle(files, body, actor.id);
  }

  @Get("uploads")
  @RequirePermissions("data.read")
  listUploads(@Query() query: CoupangUploadListQueryDto) {
    return this.coupangService.listUploads(query.take ?? 50);
  }

  @Get("uploads/:id/preview")
  @RequirePermissions("data.read")
  previewUpload(@Param() params: CoupangIdParamDto, @Query() query: CoupangUploadPreviewQueryDto) {
    return this.coupangService.previewUpload(params.id, query.take ?? 50);
  }

  @Get("uploads/:id/errors")
  @RequirePermissions("data.read")
  uploadErrors(@Param() params: CoupangIdParamDto) {
    return this.coupangService.uploadErrors(params.id);
  }

  @Delete("uploads/:id")
  @RequirePermissions("imports.manage")
  deleteUpload(@Param() params: CoupangIdParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.deleteUpload(params.id, actor.id);
  }

  @Get("product-settings")
  @RequirePermissions("data.read")
  listProductSettings(@Query() query: CoupangProductSettingsQueryDto) {
    return this.coupangService.listProductSettings(query.includeInactive === "true", query.date);
  }

  @Post("product-settings")
  @RequirePermissions("products.manage")
  createProductSetting(@Body() body: CoupangCreateProductSettingDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.createProductSetting(body, actor.id);
  }

  @Patch("product-settings/:id/configuration")
  @RequirePermissions("products.manage")
  updateProductConfiguration(
    @Param() params: CoupangIdParamDto,
    @Body() body: CoupangProductSettingDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.updateProductConfiguration(params.id, body, actor.id);
  }

  @Patch("product-settings/:productId/cost-rules/:costRuleId")
  @RequirePermissions("products.manage")
  correctProductCostRule(
    @Param() params: CoupangProductCostParamDto,
    @Body() body: CoupangCostRuleCorrectionDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.correctProductCostRule(params.productId, params.costRuleId, body, actor.id);
  }

  @Get("sales-fee-rules/current")
  @RequirePermissions("data.read")
  currentSalesFeeRule(@Query() query: CoupangManualPurchaseOptionsQueryDto) {
    return this.coupangService.currentSalesFeeRule(query.date);
  }

  @Get("sales-fee-rules")
  @RequirePermissions("data.read")
  listSalesFeeRules() {
    return this.coupangService.listSalesFeeRules();
  }

  @Post("sales-fee-rules")
  @RequirePermissions("products.manage")
  createSalesFeeRule(@Body() body: CoupangSalesFeeRuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.createSalesFeeRule(body, actor.id);
  }

  @Patch("sales-fee-rules/:id")
  @RequirePermissions("products.manage")
  correctSalesFeeRule(
    @Param() params: CoupangIdParamDto,
    @Body() body: CoupangSalesFeeRuleDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.correctSalesFeeRule(params.id, body, actor.id);
  }

  @Patch("product-settings/:id")
  @RequirePermissions("products.manage")
  updateProductSetting(
    @Param() params: CoupangIdParamDto,
    @Body() body: CoupangProductSettingDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.updateProductSetting(params.id, body, actor.id);
  }

  @Delete("product-settings/:id")
  @RequirePermissions("products.manage")
  deleteProductSetting(@Param() params: CoupangIdParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.deleteProductSetting(params.id, actor.id);
  }

  @Get("product-groups")
  @RequirePermissions("data.read")
  listProductGroups(@Query() query: CoupangIncludeInactiveQueryDto) {
    return this.coupangService.listProductGroups(query.includeInactive === "true");
  }

  @Post("product-groups")
  @RequirePermissions("products.manage")
  createProductGroup(@Body() body: CoupangProductGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.createProductGroup(body, actor.id);
  }

  @Patch("product-groups/:id")
  @RequirePermissions("products.manage")
  updateProductGroup(
    @Param() params: CoupangIdParamDto,
    @Body() body: CoupangProductGroupDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.updateProductGroup(params.id, body, actor.id);
  }

  @Delete("product-groups/:id")
  @RequirePermissions("products.manage")
  deleteProductGroup(@Param() params: CoupangIdParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.deleteProductGroup(params.id, actor.id);
  }

  @Get("mapping-rules")
  @RequirePermissions("data.read")
  listMappingRules(@Query() query: CoupangIncludeInactiveQueryDto) {
    return this.coupangService.listMappingRules(query.includeInactive === "true");
  }

  @Post("mapping-rules")
  @RequirePermissions("mappings.manage")
  createMappingRule(@Body() body: CoupangMappingRuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.createMappingRule(body, actor.id);
  }

  @Patch("mapping-rules/:id")
  @RequirePermissions("mappings.manage")
  updateMappingRule(
    @Param() params: CoupangIdParamDto,
    @Body() body: CoupangMappingRuleDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.updateMappingRule(params.id, body, actor.id);
  }

  @Delete("mapping-rules/:id")
  @RequirePermissions("mappings.manage")
  deleteMappingRule(@Param() params: CoupangIdParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.deleteMappingRule(params.id, actor.id);
  }

  @Get("manual-purchases/options")
  @RequirePermissions("data.read")
  manualPurchaseOptions(@Query() query: CoupangManualPurchaseOptionsQueryDto) {
    return this.coupangService.manualPurchaseOptions(query);
  }

  @Get("manual-purchases")
  @RequirePermissions("data.read")
  listManualPurchases(@Query() query: CoupangManualPurchasesQueryDto) {
    return this.coupangService.listManualPurchases(query);
  }

  @Put("manual-purchases/:date")
  @RequirePermissions("operations.run")
  replaceManualPurchasesForDate(
    @Param() params: CoupangManualPurchaseDateParamDto,
    @Body() body: CoupangManualPurchasesBodyDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.replaceManualPurchasesForDate(params.date, body, actor.id);
  }

  @Delete("manual-purchases/:id")
  @RequirePermissions("operations.run")
  deleteManualPurchase(@Param() params: CoupangIdParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.deleteManualPurchase(params.id, actor.id);
  }

  @Post("rematch")
  @RequirePermissions("mappings.manage")
  rematch(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: CoupangRematchQueryDto
  ) {
    return this.coupangService.rematch({
      from: query.from,
      to: query.to,
      take: query.take === undefined ? undefined : String(query.take)
    }, actor.id);
  }

  @Get("dashboard")
  @RequirePermissions("data.read")
  dashboard(@Query() query: CoupangGroupQueryDto) {
    return this.coupangService.dashboard(query);
  }

  @Get("product-profit")
  @RequirePermissions("data.read")
  productProfit(@Query() query: CoupangGroupQueryDto) {
    return this.coupangService.productProfit(query);
  }

  @Get("ads-analysis")
  @RequirePermissions("data.read")
  adsAnalysis(@Query() query: CoupangGroupQueryDto) {
    return this.coupangService.adsAnalysis(query);
  }

  @Get("unmatched")
  @RequirePermissions("data.read")
  unmatched(@Query() query: CoupangUnmatchedQueryDto) {
    return this.coupangService.unmatched({
      from: query.from,
      to: query.to,
      take: query.take === undefined ? undefined : String(query.take)
    });
  }

  @Get("mapping-issues")
  @RequirePermissions("data.read")
  mappingIssues(@Query() query: CoupangUnmatchedQueryDto) {
    return this.coupangService.mappingIssues({
      from: query.from,
      to: query.to,
      take: query.take === undefined ? undefined : String(query.take)
    });
  }

  @Get("daily-report")
  @RequirePermissions("data.read")
  dailyReport(@Query() query: CoupangDailyReportQueryDto) {
    return this.coupangService.dailyReport(query);
  }

  @Get("daily-report/categories")
  @RequirePermissions("data.read")
  listDailyReportCategories(@Query() query: CoupangIncludeInactiveQueryDto) {
    return this.coupangService.listDailyReportCategories(query.includeInactive === "true");
  }

  @Get("daily-report/category-catalog")
  @RequirePermissions("data.read")
  dailyReportCategoryCatalog(@Query() query: CoupangIncludeInactiveQueryDto) {
    return this.coupangService.dailyReportCategoryCatalog(query.includeInactive === "true");
  }

  @Post("daily-report/categories")
  @RequirePermissions("products.manage")
  createDailyReportCategory(
    @Body() body: CreateCoupangDailyReportCategoryDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.createDailyReportCategory(body, actor.id);
  }

  @Patch("daily-report/categories/:id")
  @RequirePermissions("products.manage")
  updateDailyReportCategory(
    @Param() params: CoupangIdParamDto,
    @Body() body: UpdateCoupangDailyReportCategoryDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.updateDailyReportCategory(params.id, body, actor.id);
  }

  @Put("daily-report/categories/:id/products")
  @RequirePermissions("products.manage")
  replaceDailyReportCategoryProducts(
    @Param() params: CoupangIdParamDto,
    @Body() body: ReplaceCoupangDailyReportCategoryProductsDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.coupangService.replaceDailyReportCategoryProducts(params.id, body, actor.id);
  }

  @Delete("daily-report/categories/:id")
  @RequirePermissions("products.manage")
  deleteDailyReportCategory(@Param() params: CoupangIdParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.coupangService.deleteDailyReportCategory(params.id, actor.id);
  }
}
