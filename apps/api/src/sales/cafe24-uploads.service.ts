import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConflictPolicy, MatchSource, Prisma, RowValidationStatus, UploadStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { normalizeUploadedFilename } from "../common/encoding";
import { asDateOnly, parseDateRange } from "../common/date-range";
import { PrismaService } from "../common/prisma.service";
import {
  cafe24OrderLineKey,
  Cafe24CsvHeaderValidator,
  Cafe24CsvParser,
  CAFE24_ORDER_SCHEMA_VERSION,
  hashCafe24Record,
  ParsedCafe24OrderRow,
  readCafe24ColumnValue
} from "../domain/cafe24-csv";
import { Cafe24ProductMatcher, Cafe24RuleInput } from "../domain/cafe24-matcher";
import { formatDateOnly, ParseIssue } from "../domain/date-number";
import { ExchangeRatesService } from "../exchange-rates/exchange-rates.service";

@Injectable()
export class Cafe24UploadsService {
  private readonly parser = new Cafe24CsvParser();
  private readonly matcher = new Cafe24ProductMatcher();

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRatesService: ExchangeRatesService
  ) {}

  async importCafe24Csv(file: Express.Multer.File | undefined, conflictPolicy: ConflictPolicy) {
    if (!file?.buffer) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "Cafe24 CSV file is required." });
    }
    if (!(conflictPolicy in ConflictPolicy)) {
      throw new BadRequestException({ code: "INVALID_CONFLICT_POLICY", message: "Invalid conflict policy." });
    }

    const fileHashSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const reusableDuplicate =
      conflictPolicy === ConflictPolicy.SKIP ? await this.findReusableCafe24Duplicate(fileHashSha256) : null;
    if (reusableDuplicate) {
      if (!reusableDuplicate.importedAt) {
        await this.refreshCafe24BatchIssueCounts([reusableDuplicate.id]);
      }
      return this.duplicateUploadSummary(reusableDuplicate.id);
    }

    const duplicated = await this.prisma.cafe24UploadBatch.findUnique({ where: { fileHashSha256 } });
    const duplicatedIsIncomplete = duplicated ? await this.isIncompleteCafe24Upload(duplicated.id, duplicated.rowCount) : false;
    if (duplicatedIsIncomplete && duplicated) {
      await this.refreshCafe24BatchIssueCounts([duplicated.id]);
    }

    const importConflictPolicy = resolveCafe24ImportConflictPolicy({ conflictPolicy, duplicatedIsIncomplete });
    const batchFileHashSha256 = duplicated ? duplicateBatchHash(fileHashSha256, importConflictPolicy) : fileHashSha256;
    const originalFilename = normalizeUploadedFilename(file.originalname);
    const { headers, rows } = this.parser.parseBuffer(file.buffer);
    const previewSummary = this.parser.preview(file.buffer);
    const batch = await this.prisma.cafe24UploadBatch.create({
      data: {
        originalFilename,
        storedFilePath: null,
        fileHashSha256: batchFileHashSha256,
        columnSchema: {
          schemaVersion: CAFE24_ORDER_SCHEMA_VERSION,
          columns: headers,
          count: headers.length,
          previewSummary,
          originalFileHashSha256: fileHashSha256,
          rawRowPolicy: "PII_COLUMNS_REMOVED"
        },
        rowCount: rows.length,
        conflictPolicy: importConflictPolicy,
        status: UploadStatus.VALIDATING
      }
    });

    const headerValidation = Cafe24CsvHeaderValidator.validate(headers);
    if (!headerValidation.valid) {
      await this.prisma.cafe24UploadRowError.createMany({
        data: headerValidation.missingColumns.map((columnName) => ({
          uploadBatchId: batch.id,
          columnName,
          severity: "ERROR",
          errorCode: "MISSING_REQUIRED_COLUMN",
          message: `Required Cafe24 column is missing: ${columnName}`
        }))
      });
      await this.prisma.cafe24UploadBatch.update({
        where: { id: batch.id },
        data: { status: UploadStatus.FAILED, errorCount: headerValidation.missingColumns.length, validatedAt: new Date() }
      });
      throw new BadRequestException({
        code: "CSV_HEADER_INVALID",
        message: "Required Cafe24 CSV columns are missing.",
        details: { batchId: batch.id, missingColumns: headerValidation.missingColumns, previewSummary }
      });
    }

    const parsedRows = rows.map((rawRow, index) => {
      const sanitizedRawRow = this.parser.sanitizedRawRow(rawRow);
      return {
        rowNumber: index + 2,
        rawRow,
        sanitizedRawRow,
        sourceRowHash: hashCafe24Record(sanitizedRawRow),
        parsed: this.parser.parseRow(rawRow)
      };
    });
    const duplicateKeys = duplicatedValues(
      parsedRows.map(({ parsed, rawRow }) => effectiveCafe24OrderLineKey(parsed.parsedRow, rawRow))
    );
    const duplicateKeySet = new Set(duplicateKeys);

    let validRowCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let unmatchedCount = 0;
    let ambiguousCount = 0;
    let matchedCount = 0;
    let orderStart: Date | null = null;
    let orderEnd: Date | null = null;
    let failedRowNumber: number | null = null;

    const orderDates = parsedRows
      .map(({ parsed }) => parsed.parsedRow?.orderDate)
      .filter((date): date is Date => Boolean(date));
    try {
      await this.exchangeRatesService.ensureUsdKrwRatesForDates(orderDates);
    } catch (error) {
      warningCount += 1;
      await this.prisma.cafe24UploadRowError.create({
        data: {
          uploadBatchId: batch.id,
          severity: "WARNING",
          errorCode: "EXCHANGE_RATE_SYNC_FAILED",
          message: error instanceof Error ? error.message : "Failed to prepare USD/KRW exchange rates for Cafe24 dates."
        }
      });
    }

    let updated: typeof batch;
    try {
      const matcherRules = await this.matcherRules();
      updated = await this.prisma.$transaction(
        async (tx) => {
          for (const { rowNumber, rawRow, sanitizedRawRow, sourceRowHash, parsed } of parsedRows) {
            failedRowNumber = rowNumber;
            const parsedRow = parsed.parsedRow;
            const issues = parsed.issues.map((issue) => rowIssue(issue, "ERROR"));
            let productId: string | null = null;
            let cafe24ProductRuleId: string | null = null;
            let matchSource: MatchSource = MatchSource.UNMATCHED;
            const orderLineKey = effectiveCafe24OrderLineKey(parsedRow, rawRow);
            const warnings: RowIssue[] = [];

            if (duplicateKeySet.has(orderLineKey)) {
              warnings.push({
                columnName: null,
                errorCode: "DUPLICATE_ORDER_LINE_KEY",
                message: `Duplicate Cafe24 order line key in this upload: ${orderLineKey}`,
                rawValue: orderLineKey,
                severity: "WARNING"
              });
            }

            if (parsedRow) {
              if (parsedRow.orderDate) {
                orderStart = minDate(orderStart, parsedRow.orderDate);
                orderEnd = maxDate(orderEnd, parsedRow.orderDate);
              }

              const match = this.matcher.match(parsedRow, matcherRules);
              if (match.reason === "MATCHED") {
                productId = match.productId;
                cafe24ProductRuleId = match.matchRuleId;
                matchSource = MatchSource.RULE;
                matchedCount += 1;
              } else if (match.reason === "AMBIGUOUS_MATCH") {
                warnings.push({
                  columnName: null,
                  errorCode: "CAFE24_PRODUCT_AMBIGUOUS",
                  message: "Cafe24 order line matched more than one active rule.",
                  rawValue: match.candidates.join(", "),
                  severity: "WARNING"
                });
                ambiguousCount += 1;
              } else {
                warnings.push({
                  columnName: null,
                  errorCode: "CAFE24_PRODUCT_UNMATCHED",
                  message: "Cafe24 order line did not match any active product rule.",
                  severity: "WARNING"
                });
                unmatchedCount += 1;
              }
            }

            const validationStatus =
              issues.length > 0
                ? RowValidationStatus.ERROR
                : productId
                  ? warnings.length > 0
                    ? RowValidationStatus.WARNING
                    : RowValidationStatus.VALID
                  : warnings.some((warning) => warning.errorCode === "CAFE24_PRODUCT_AMBIGUOUS")
                    ? RowValidationStatus.WARNING
                    : RowValidationStatus.UNMATCHED;

            if (issues.length > 0) {
              errorCount += 1;
            } else {
              validRowCount += 1;
            }

            const saved = await this.saveCafe24OrderLine(
              {
                conflictPolicy: importConflictPolicy,
                batchId: batch.id,
                rowNumber,
                sourceRowHash,
                orderLineKey,
                parsedRow,
                rawRow,
                sanitizedRawRow,
                productId,
                cafe24ProductRuleId,
                matchSource,
                validationStatus,
                validationErrors: [...issues, ...warnings]
              },
              tx
            );
            warningCount += warnings.length + saved.policyWarnings.length;
            const line = saved.line;

            const rowErrors = [...issues, ...warnings, ...saved.policyWarnings];
            if (rowErrors.length > 0) {
              await tx.cafe24UploadRowError.createMany({
                data: rowErrors.map((issue) => ({
                  uploadBatchId: batch.id,
                  orderLineId: line.id,
                  rowNumber,
                  columnName: issue.columnName,
                  severity: issue.severity,
                  errorCode: issue.errorCode,
                  message: issue.message,
                  rawValue: issue.rawValue
                }))
              });
            }
          }

          const status =
            errorCount > 0 && validRowCount > 0
              ? UploadStatus.PARTIAL
              : errorCount > 0
                ? UploadStatus.FAILED
                : UploadStatus.IMPORTED;

          return tx.cafe24UploadBatch.update({
            where: { id: batch.id },
            data: {
              status,
              validRowCount,
              warningCount,
              errorCount,
              orderStart,
              orderEnd,
              validatedAt: new Date(),
              importedAt: validRowCount > 0 ? new Date() : null
            }
          });
        },
        { timeout: 60_000 }
      );
    } catch (error) {
      await this.markCafe24ImportFailed(batch.id, failedRowNumber, error);
      throw error;
    }

    return {
      batchId: updated.id,
      schemaVersion: CAFE24_ORDER_SCHEMA_VERSION,
      status: updated.status,
      rowCount: updated.rowCount,
      validRowCount,
      warningCount,
      errorCount,
      matchedCount,
      unmatchedCount,
      ambiguousCount,
      orderStart: orderStart ? formatDateOnly(orderStart) : null,
      orderEnd: orderEnd ? formatDateOnly(orderEnd) : null,
      previewSummary
    };
  }

  listUploads(take = 50) {
    return this.prisma.cafe24UploadBatch.findMany({
      take,
      orderBy: { uploadedAt: "desc" },
      include: { _count: { select: { rows: true, errors: true } } }
    });
  }

  async previewUpload(id: string, take = 50) {
    await this.assertUpload(id);
    return this.prisma.cafe24OrderLine.findMany({
      where: { uploadBatchId: id },
      take,
      orderBy: { rowNumber: "asc" },
      include: { product: true, matchRule: true }
    });
  }

  async uploadErrors(id: string) {
    await this.assertUpload(id);
    return this.prisma.cafe24UploadRowError.findMany({
      where: { uploadBatchId: id },
      orderBy: [{ rowNumber: "asc" }, { createdAt: "asc" }]
    });
  }

  async deleteUpload(id: string) {
    await this.assertUpload(id);
    return this.prisma.$transaction(async (tx) => {
      const deletingLines = await tx.cafe24OrderLine.findMany({
        where: { uploadBatchId: id },
        select: { id: true, orderLineKey: true, isCurrent: true }
      });
      const currentDeletedKeys = uniqueNonEmpty(deletingLines.filter((line) => line.isCurrent).map((line) => line.orderLineKey));
      await tx.cafe24UploadRowError.deleteMany({ where: { uploadBatchId: id } });
      await tx.cafe24OrderLine.deleteMany({ where: { uploadBatchId: id } });
      await this.restoreCurrentCafe24OrderLines(tx, currentDeletedKeys);
      return tx.cafe24UploadBatch.delete({ where: { id } });
    });
  }

  async rematchCafe24Lines(query: { from?: string; to?: string; take?: string }) {
    const range = parseDateRange(query.from, query.to);
    const take = Math.min(Math.max(Number(query.take ?? 1000) || 1000, 1), 5000);
    const rules = await this.matcherRules();
    const completeCafe24BatchIds = await this.completeCafe24BatchIds(range);
    const lines =
      completeCafe24BatchIds.length > 0
        ? await this.prisma.cafe24OrderLine.findMany({
            where: {
              isCurrent: true,
              uploadBatchId: { in: completeCafe24BatchIds },
              orderDate: { gte: range.fromDate, lte: range.toDate },
              validationStatus: { not: RowValidationStatus.ERROR }
            },
            take,
            orderBy: [{ orderDate: "asc" }, { rowNumber: "asc" }]
          })
        : [];

    let matchedCount = 0;
    let stillUnmatchedCount = 0;
    let ambiguousCount = 0;

    for (const line of lines) {
      const match = this.matcher.match(
        {
          productNo: line.productNo,
          productName: line.productName,
          optionName: line.optionName,
          orderDate: line.orderDate
        },
        rules
      );
      const retainedIssues = nonMatchIssues(line.validationErrors);
      const matchIssues: RowIssue[] = [];
      let productId: string | null = null;
      let cafe24ProductRuleId: string | null = null;
      let matchSource: MatchSource = MatchSource.UNMATCHED;
      let validationStatus: RowValidationStatus =
        retainedIssues.length > 0 ? RowValidationStatus.WARNING : RowValidationStatus.VALID;

      if (match.reason === "MATCHED") {
        productId = match.productId;
        cafe24ProductRuleId = match.matchRuleId;
        matchSource = MatchSource.RULE;
        matchedCount += 1;
      } else if (match.reason === "AMBIGUOUS_MATCH") {
        matchIssues.push({
          columnName: null,
          errorCode: "CAFE24_PRODUCT_AMBIGUOUS",
          message: "Cafe24 order line matched more than one active rule.",
          rawValue: match.candidates.join(", "),
          severity: "WARNING"
        });
        validationStatus = RowValidationStatus.WARNING;
        ambiguousCount += 1;
      } else {
        matchIssues.push({
          columnName: null,
          errorCode: "CAFE24_PRODUCT_UNMATCHED",
          message: "Cafe24 order line did not match any active product rule.",
          severity: "WARNING"
        });
        validationStatus = RowValidationStatus.UNMATCHED;
        stillUnmatchedCount += 1;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.cafe24OrderLine.update({
          where: { id: line.id },
          data: {
            productId,
            cafe24ProductRuleId,
            matchSource,
            validationStatus,
            validationErrors: [...retainedIssues, ...matchIssues] as unknown as Prisma.InputJsonValue
          }
        });
        await tx.cafe24UploadRowError.deleteMany({
          where: {
            orderLineId: line.id,
            errorCode: { in: ["CAFE24_PRODUCT_UNMATCHED", "CAFE24_PRODUCT_AMBIGUOUS"] }
          }
        });
        if (matchIssues.length > 0) {
          await tx.cafe24UploadRowError.createMany({
            data: matchIssues.map((issue) => ({
              uploadBatchId: line.uploadBatchId,
              orderLineId: line.id,
              rowNumber: line.rowNumber,
              columnName: issue.columnName,
              severity: issue.severity,
              errorCode: issue.errorCode,
              message: issue.message,
              rawValue: issue.rawValue
            }))
          });
        }
      });
    }

    await this.refreshCafe24BatchIssueCounts(uniqueNonEmpty(lines.map((line) => line.uploadBatchId)));

    return {
      period: { from: range.from, to: range.to },
      scannedCount: lines.length,
      matchedCount,
      stillUnmatchedCount,
      ambiguousCount
    };
  }

  listRules(query: { productId?: string; includeInactive?: boolean } = {}) {
    return this.prisma.cafe24ProductRule.findMany({
      where: {
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.includeInactive ? {} : { isActive: true })
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: { product: true, adCostSourceProduct: true }
    });
  }

  async createRule(body: Record<string, unknown>) {
    const product = await this.assertProduct(requiredString(body.productId, "productId"));
    const adCostSourceProductId = optionalString(body.adCostSourceProductId);
    if (adCostSourceProductId) {
      await this.assertProduct(adCostSourceProductId);
    }

    return this.prisma.cafe24ProductRule.create({
      data: {
        productId: product.id,
        displayName: optionalString(body.displayName) ?? product.displayName,
        productNumbers: stringArray(body.productNumbers) ?? [],
        productNameAliases: stringArray(body.productNameAliases) ?? [],
        optionIncludeKeywords: stringArray(body.optionIncludeKeywords) ?? [],
        optionExcludeKeywords: stringArray(body.optionExcludeKeywords) ?? [],
        adCostSourceProductId,
        roasGroup: optionalString(body.roasGroup),
        salePriceKrwOverride: optionalDecimal(body.salePriceKrwOverride, "salePriceKrwOverride"),
        productCostKrwOverride: optionalDecimal(body.productCostKrwOverride, "productCostKrwOverride"),
        shippingKrwOverride: optionalDecimal(body.shippingKrwOverride, "shippingKrwOverride"),
        extraCostKrwOverride: optionalDecimal(body.extraCostKrwOverride, "extraCostKrwOverride"),
        priority: numberOrDefault(body.priority, 100),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        validFrom: body.validFrom ? asDateOnly(String(body.validFrom)) : undefined,
        validTo: body.validTo ? asDateOnly(String(body.validTo)) : null,
        note: optionalString(body.note)
      }
    });
  }

  async updateRule(id: string, body: Record<string, unknown>) {
    await this.assertRule(id);
    const productId = optionalString(body.productId);
    if (productId) {
      await this.assertProduct(productId);
    }
    const adCostSourceProductId =
      body.adCostSourceProductId === null ? null : optionalString(body.adCostSourceProductId);
    if (adCostSourceProductId) {
      await this.assertProduct(adCostSourceProductId);
    }

    return this.prisma.cafe24ProductRule.update({
      where: { id },
      data: {
        productId,
        displayName: optionalString(body.displayName),
        productNumbers: body.productNumbers === undefined ? undefined : stringArray(body.productNumbers) ?? [],
        productNameAliases:
          body.productNameAliases === undefined ? undefined : stringArray(body.productNameAliases) ?? [],
        optionIncludeKeywords:
          body.optionIncludeKeywords === undefined ? undefined : stringArray(body.optionIncludeKeywords) ?? [],
        optionExcludeKeywords:
          body.optionExcludeKeywords === undefined ? undefined : stringArray(body.optionExcludeKeywords) ?? [],
        adCostSourceProductId: body.adCostSourceProductId === undefined ? undefined : adCostSourceProductId,
        roasGroup: body.roasGroup === null ? null : optionalString(body.roasGroup),
        salePriceKrwOverride: optionalDecimal(body.salePriceKrwOverride, "salePriceKrwOverride"),
        productCostKrwOverride: optionalDecimal(body.productCostKrwOverride, "productCostKrwOverride"),
        shippingKrwOverride: optionalDecimal(body.shippingKrwOverride, "shippingKrwOverride"),
        extraCostKrwOverride: optionalDecimal(body.extraCostKrwOverride, "extraCostKrwOverride"),
        priority: body.priority === undefined ? undefined : numberOrDefault(body.priority, 100),
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        validFrom: body.validFrom === undefined ? undefined : asDateOnly(String(body.validFrom)),
        validTo: body.validTo === undefined ? undefined : body.validTo === null ? null : asDateOnly(String(body.validTo)),
        note: body.note === null ? null : optionalString(body.note)
      }
    });
  }

  async deleteRule(id: string) {
    await this.assertRule(id);
    const lineCount = await this.prisma.cafe24OrderLine.count({ where: { cafe24ProductRuleId: id } });
    if (lineCount > 0) {
      return { mode: "deactivated", rule: await this.prisma.cafe24ProductRule.update({ where: { id }, data: { isActive: false } }) };
    }
    return { mode: "deleted", rule: await this.prisma.cafe24ProductRule.delete({ where: { id } }) };
  }

  private async matcherRules(): Promise<Cafe24RuleInput[]> {
    const rules = await this.prisma.cafe24ProductRule.findMany({
      where: { isActive: true, product: { is: { isActive: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
    });
    return rules.map((rule) => ({
      id: rule.id,
      productId: rule.productId,
      displayName: rule.displayName,
      productNumbers: jsonStringArray(rule.productNumbers),
      productNameAliases: jsonStringArray(rule.productNameAliases),
      optionIncludeKeywords: jsonStringArray(rule.optionIncludeKeywords),
      optionExcludeKeywords: jsonStringArray(rule.optionExcludeKeywords),
      priority: rule.priority,
      validFrom: formatDateOnly(rule.validFrom),
      validTo: rule.validTo ? formatDateOnly(rule.validTo) : null,
      isActive: rule.isActive,
      adCostSourceProductId: rule.adCostSourceProductId,
      roasGroup: rule.roasGroup
    }));
  }

  private async duplicateUploadSummary(batchId: string) {
    const batch = await this.assertUpload(batchId);
    return {
      duplicate: true,
      batchId: batch.id,
      status: batch.status,
      rowCount: batch.rowCount,
      validRowCount: batch.validRowCount,
      warningCount: batch.warningCount,
      errorCount: batch.errorCount,
      matchedCount: await this.prisma.cafe24OrderLine.count({ where: { uploadBatchId: batch.id, productId: { not: null } } }),
      unmatchedCount: await this.prisma.cafe24OrderLine.count({ where: { uploadBatchId: batch.id, productId: null } }),
      orderStart: batch.orderStart ? formatDateOnly(batch.orderStart) : null,
      orderEnd: batch.orderEnd ? formatDateOnly(batch.orderEnd) : null
    };
  }

  private async isIncompleteCafe24Upload(batchId: string, rowCount: number) {
    const storedRowCount = await this.prisma.cafe24OrderLine.count({ where: { uploadBatchId: batchId } });
    return !isCompleteCafe24UploadBatch({ rowCount, storedRowCount });
  }

  private async findReusableCafe24Duplicate(fileHashSha256: string) {
    const batches = await this.prisma.cafe24UploadBatch.findMany({
      where: {
        status: { in: [UploadStatus.IMPORTED, UploadStatus.PARTIAL] },
        OR: [
          { fileHashSha256 },
          { columnSchema: { path: ["originalFileHashSha256"], equals: fileHashSha256 } }
        ]
      },
      orderBy: { uploadedAt: "desc" }
    });

    for (const batch of batches) {
      if (!(await this.isIncompleteCafe24Upload(batch.id, batch.rowCount))) {
        return batch;
      }
    }
    return null;
  }

  private async completeCafe24BatchIds(range: ReturnType<typeof parseDateRange>) {
    const batches = await this.prisma.cafe24UploadBatch.findMany({
      where: {
        status: { in: [UploadStatus.IMPORTED, UploadStatus.PARTIAL] },
        OR: [
          { orderStart: null },
          { orderEnd: null },
          { orderStart: { lte: range.toDate }, orderEnd: { gte: range.fromDate } }
        ]
      },
      select: {
        id: true,
        rowCount: true,
        status: true,
        _count: { select: { rows: true } }
      }
    });
    return batches
      .filter((batch) =>
        isUsableCafe24UploadBatch({ status: batch.status, rowCount: batch.rowCount, storedRowCount: batch._count.rows })
      )
      .map((batch) => batch.id);
  }

  private async assertUpload(id: string) {
    const upload = await this.prisma.cafe24UploadBatch.findUnique({ where: { id } });
    if (!upload) {
      throw new NotFoundException({ code: "CAFE24_UPLOAD_NOT_FOUND", message: "Cafe24 upload was not found." });
    }
    return upload;
  }

  private async assertProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (product && !product.isActive) {
      throw new BadRequestException({ code: "PRODUCT_INACTIVE", message: "Inactive products cannot be used for Cafe24 rules." });
    }
    if (!product) {
      throw new NotFoundException({ code: "PRODUCT_NOT_FOUND", message: "Product was not found." });
    }
    return product;
  }

  private async assertRule(id: string) {
    const rule = await this.prisma.cafe24ProductRule.findUnique({ where: { id } });
    if (!rule) {
      throw new NotFoundException({ code: "CAFE24_RULE_NOT_FOUND", message: "Cafe24 product rule was not found." });
    }
    return rule;
  }

  private async saveCafe24OrderLine(input: SaveCafe24OrderLineInput, client?: Prisma.TransactionClient) {
    const policyWarnings: RowIssue[] = [];
    const save = async (tx: Prisma.TransactionClient) => {
      const existingCurrentLines = await tx.cafe24OrderLine.findMany({
        where: { orderLineKey: input.orderLineKey, isCurrent: true },
        orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }]
      });
      const existingCurrent = existingCurrentLines[0] ?? null;
      const decision = resolveCafe24LineImportDecision({
        conflictPolicy: input.conflictPolicy,
        existingCurrent
      });
      const storedState = resolveCafe24LineStoredState({
        validationStatus: input.validationStatus,
        decision
      });

      if (decision.skippedDuplicate) {
        policyWarnings.push({
          columnName: null,
          errorCode: "CAFE24_ORDER_LINE_ALREADY_CURRENT",
          message: "Cafe24 order line already has a current version; this imported row was kept as non-current.",
          rawValue: input.orderLineKey,
          severity: "WARNING"
        });
      }

      if (storedState.supersedeExisting && existingCurrentLines.length > 0) {
        await tx.cafe24OrderLine.updateMany({
          where: { id: { in: existingCurrentLines.map((line) => line.id) } },
          data: { isCurrent: false }
        });
      }

      const created = await tx.cafe24OrderLine.create({
        data: {
          uploadBatchId: input.batchId,
          rowNumber: input.rowNumber,
          sourceRowHash: input.sourceRowHash,
          orderLineKey: input.orderLineKey,
          orderNo: input.parsedRow?.orderNo ?? rawString(input.rawRow, "orderNo"),
          lineOrderNo: input.parsedRow?.lineOrderNo ?? rawString(input.rawRow, "lineOrderNo"),
          productNo: input.parsedRow?.productNo ?? rawString(input.rawRow, "productNo"),
          productName: input.parsedRow?.productName ?? rawString(input.rawRow, "productName"),
          optionName: input.parsedRow?.optionName ?? rawString(input.rawRow, "optionName"),
          quantity: new Prisma.Decimal(input.parsedRow?.quantity ?? 0),
          salePriceKrw: new Prisma.Decimal(input.parsedRow?.salePriceKrw ?? 0),
          totalPaidKrw: new Prisma.Decimal(input.parsedRow?.totalPaidKrw ?? 0),
          paymentMethod: input.parsedRow?.paymentMethod,
          orderedAt: input.parsedRow?.orderedAt,
          orderDate: input.parsedRow?.orderDate,
          productId: input.productId,
          cafe24ProductRuleId: input.cafe24ProductRuleId,
          matchSource: input.matchSource,
          validationStatus: policyWarnings.length > 0 && input.validationStatus === RowValidationStatus.VALID
            ? RowValidationStatus.WARNING
            : input.validationStatus,
          validationErrors: [...input.validationErrors, ...policyWarnings] as unknown as Prisma.InputJsonValue,
          importVersion: storedState.importVersion,
          isCurrent: storedState.isCurrent,
          rawRow: input.sanitizedRawRow as Prisma.InputJsonObject
        }
      });

      if (storedState.supersedeExisting && existingCurrentLines.length > 0) {
        await tx.cafe24OrderLine.updateMany({
          where: { id: { in: existingCurrentLines.map((line) => line.id) } },
          data: { supersededByOrderLineId: created.id }
        });
      }

      return created;
    };
    const line = client ? await save(client) : await this.prisma.$transaction(save);

    return { line, policyWarnings };
  }

  private async markCafe24ImportFailed(batchId: string, rowNumber: number | null, error: unknown) {
    await this.prisma.cafe24UploadRowError.create({
      data: {
        uploadBatchId: batchId,
        rowNumber,
        severity: "ERROR",
        errorCode: "CAFE24_IMPORT_FAILED",
        message: error instanceof Error ? error.message : "Cafe24 CSV import failed before all rows were saved."
      }
    });
    const [warningCount, errorCount, validRowCount] = await Promise.all([
      this.prisma.cafe24UploadRowError.count({ where: { uploadBatchId: batchId, severity: "WARNING" } }),
      this.prisma.cafe24UploadRowError.count({ where: { uploadBatchId: batchId, severity: "ERROR" } }),
      this.prisma.cafe24OrderLine.count({
        where: { uploadBatchId: batchId, validationStatus: { not: RowValidationStatus.ERROR } }
      })
    ]);

    await this.prisma.cafe24UploadBatch.update({
      where: { id: batchId },
      data: {
        status: validRowCount > 0 ? UploadStatus.PARTIAL : UploadStatus.FAILED,
        validRowCount,
        warningCount,
        errorCount,
        validatedAt: new Date(),
        importedAt: null
      }
    });
  }

  private async refreshCafe24BatchIssueCounts(batchIds: string[]) {
    for (const batchId of batchIds) {
      const [batch, warningCount, errorCount, validRowCount, storedRowCount, orderDateBounds] = await Promise.all([
        this.prisma.cafe24UploadBatch.findUnique({ where: { id: batchId }, select: { rowCount: true, importedAt: true } }),
        this.prisma.cafe24UploadRowError.count({ where: { uploadBatchId: batchId, severity: "WARNING" } }),
        this.prisma.cafe24UploadRowError.count({ where: { uploadBatchId: batchId, severity: "ERROR" } }),
        this.prisma.cafe24OrderLine.count({
          where: { uploadBatchId: batchId, validationStatus: { not: RowValidationStatus.ERROR } }
        }),
        this.prisma.cafe24OrderLine.count({ where: { uploadBatchId: batchId } }),
        this.prisma.cafe24OrderLine.aggregate({
          where: { uploadBatchId: batchId, orderDate: { not: null } },
          _min: { orderDate: true },
          _max: { orderDate: true }
        })
      ]);
      if (!batch) {
        continue;
      }
      const isComplete = isCompleteCafe24UploadBatch({ rowCount: batch.rowCount, storedRowCount });
      const hasMissingRows = !isComplete;
      const status =
        hasMissingRows && storedRowCount > 0
          ? UploadStatus.PARTIAL
          : hasMissingRows
            ? UploadStatus.FAILED
            : errorCount > 0 && validRowCount > 0
              ? UploadStatus.PARTIAL
              : errorCount > 0
                ? UploadStatus.FAILED
                : UploadStatus.IMPORTED;

      await this.prisma.$transaction(async (tx) => {
        await tx.cafe24UploadBatch.update({
          where: { id: batchId },
          data: {
            status,
            validRowCount,
            warningCount,
            errorCount,
            orderStart: orderDateBounds._min.orderDate,
            orderEnd: orderDateBounds._max.orderDate,
            importedAt: validRowCount > 0 && isComplete ? (batch.importedAt ?? new Date()) : null
          }
        });
        if (hasMissingRows) {
          await this.demoteIncompleteCafe24CurrentLines(tx, batchId);
        }
      });
    }
  }

  private async demoteIncompleteCafe24CurrentLines(tx: Prisma.TransactionClient, batchId: string) {
    const currentLines = await tx.cafe24OrderLine.findMany({
      where: { uploadBatchId: batchId, isCurrent: true },
      select: { orderLineKey: true }
    });
    const currentKeys = uniqueNonEmpty(currentLines.map((line) => line.orderLineKey));
    if (currentKeys.length === 0) {
      return;
    }
    await this.restoreCurrentCafe24OrderLines(tx, currentKeys);
  }

  private async restoreCurrentCafe24OrderLines(tx: Prisma.TransactionClient, orderLineKeys: string[]) {
    for (const orderLineKey of orderLineKeys) {
      await tx.cafe24OrderLine.updateMany({
        where: { orderLineKey },
        data: { isCurrent: false }
      });
      const candidates = await tx.cafe24OrderLine.findMany({
        where: { orderLineKey, validationStatus: { not: RowValidationStatus.ERROR } },
        orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          uploadBatchId: true,
          batch: { select: { rowCount: true, status: true } }
        }
      });
      let latest: { id: string } | null = null;
      for (const candidate of candidates) {
        const storedRowCount = await tx.cafe24OrderLine.count({ where: { uploadBatchId: candidate.uploadBatchId } });
        if (isUsableCafe24UploadBatch({ status: candidate.batch.status, rowCount: candidate.batch.rowCount, storedRowCount })) {
          latest = candidate;
          break;
        }
      }
      if (latest) {
        await tx.cafe24OrderLine.update({
          where: { id: latest.id },
          data: { isCurrent: true, supersededByOrderLineId: null }
        });
      }
    }
  }
}

type RowIssue = Omit<ParseIssue, "columnName"> & {
  columnName: string | null;
  severity: "ERROR" | "WARNING";
};

type SaveCafe24OrderLineInput = {
  conflictPolicy: ConflictPolicy;
  batchId: string;
  rowNumber: number;
  sourceRowHash: string;
  orderLineKey: string;
  parsedRow: ParsedCafe24OrderRow | null;
  rawRow: Record<string, string>;
  sanitizedRawRow: Record<string, string>;
  productId: string | null;
  cafe24ProductRuleId: string | null;
  matchSource: MatchSource;
  validationStatus: RowValidationStatus;
  validationErrors: RowIssue[];
};

type ExistingCurrentCafe24Line = {
  id: string;
  importVersion: number;
} | null;

type Cafe24LineImportDecision = {
  importVersion: number;
  isCurrent: boolean;
  supersedeExisting: boolean;
  skippedDuplicate: boolean;
};

export function resolveCafe24LineImportDecision(input: {
  conflictPolicy: ConflictPolicy;
  existingCurrent: ExistingCurrentCafe24Line;
}): Cafe24LineImportDecision {
  if (!input.existingCurrent) {
    return {
      importVersion: 1,
      isCurrent: true,
      supersedeExisting: false,
      skippedDuplicate: false
    };
  }

  if (input.conflictPolicy === ConflictPolicy.SKIP) {
    return {
      importVersion: input.existingCurrent.importVersion,
      isCurrent: false,
      supersedeExisting: false,
      skippedDuplicate: true
    };
  }

  return {
    importVersion:
      input.conflictPolicy === ConflictPolicy.NEW_VERSION
        ? input.existingCurrent.importVersion + 1
        : input.existingCurrent.importVersion,
    isCurrent: true,
    supersedeExisting: true,
    skippedDuplicate: false
  };
}

export function resolveCafe24ImportConflictPolicy(input: {
  conflictPolicy: ConflictPolicy;
  duplicatedIsIncomplete: boolean;
}) {
  if (input.duplicatedIsIncomplete && input.conflictPolicy === ConflictPolicy.SKIP) {
    return ConflictPolicy.OVERWRITE;
  }
  return input.conflictPolicy;
}

export function isCompleteCafe24UploadBatch(input: { rowCount: number; storedRowCount: number }) {
  return input.storedRowCount >= input.rowCount;
}

export function isUsableCafe24UploadBatch(input: { status: UploadStatus; rowCount: number; storedRowCount: number }) {
  return (
    (input.status === UploadStatus.IMPORTED || input.status === UploadStatus.PARTIAL) &&
    isCompleteCafe24UploadBatch({ rowCount: input.rowCount, storedRowCount: input.storedRowCount })
  );
}

export function resolveCafe24LineStoredState(input: {
  validationStatus: RowValidationStatus;
  decision: Cafe24LineImportDecision;
}): Cafe24LineImportDecision {
  if (input.validationStatus === RowValidationStatus.ERROR) {
    return {
      ...input.decision,
      isCurrent: false,
      supersedeExisting: false
    };
  }
  return input.decision;
}

export function effectiveCafe24OrderLineKey(parsedRow: ParsedCafe24OrderRow | null, rawRow: Record<string, string>) {
  return parsedRow ? cafe24OrderLineKey(parsedRow) : fallbackOrderLineKey(rawRow);
}

function rowIssue(issue: ParseIssue, severity: RowIssue["severity"]): RowIssue {
  return { ...issue, columnName: issue.columnName ?? null, severity };
}

function rawString(rawRow: Record<string, string>, key: Parameters<typeof readCafe24ColumnValue>[1]) {
  return readCafe24ColumnValue(rawRow, key)?.trim() ?? "";
}

function fallbackOrderLineKey(rawRow: Record<string, string>) {
  return [rawString(rawRow, "orderNo"), rawString(rawRow, "lineOrderNo"), rawString(rawRow, "productNo"), rawString(rawRow, "optionName")]
    .map((value) => value.trim())
    .join(":");
}

function nonMatchIssues(value: Prisma.JsonValue): RowIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as unknown[])
    .filter(isIssueRecord)
    .filter((issue) => {
      const code = String(issue.errorCode ?? "");
      return code !== "CAFE24_PRODUCT_UNMATCHED" && code !== "CAFE24_PRODUCT_AMBIGUOUS";
    })
    .map((issue) => ({
      columnName: typeof issue.columnName === "string" ? issue.columnName : null,
      errorCode: String(issue.errorCode ?? "UNKNOWN"),
      message: String(issue.message ?? ""),
      rawValue: issue.rawValue === undefined || issue.rawValue === null ? undefined : String(issue.rawValue),
      severity: issue.severity === "ERROR" ? "ERROR" : "WARNING"
    }));
}

function isIssueRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function minDate(current: Date | null, next: Date) {
  return current && current < next ? current : next;
}

function maxDate(current: Date | null, next: Date) {
  return current && current > next ? current : next;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} is required.` });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function optionalDecimal(value: unknown, field: string): Prisma.Decimal | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException({ code: "INVALID_NUMBER", message: `${field} must be numeric.` });
  }
  return new Prisma.Decimal(parsed);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return uniqueNonEmpty(value.map((item) => String(item)));
  }
  if (typeof value === "string") {
    return uniqueNonEmpty(value.split(","));
  }
  throw new BadRequestException({ code: "INVALID_ARRAY", message: "Expected an array of strings or a comma-separated string." });
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueNonEmpty(value.map((item) => String(item)));
}

function uniqueNonEmpty(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function duplicatedValues(values: string[]) {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }
  return Array.from(duplicated);
}

function duplicateBatchHash(fileHashSha256: string, conflictPolicy: ConflictPolicy) {
  return createHash("sha256").update(`${fileHashSha256}:${conflictPolicy}:${Date.now()}:${Math.random()}`).digest("hex");
}
