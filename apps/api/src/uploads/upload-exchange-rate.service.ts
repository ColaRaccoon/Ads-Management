import { BadRequestException, Injectable } from "@nestjs/common";
import { UploadStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { ExchangeRatesService } from "../exchange-rates/exchange-rates.service";

@Injectable()
export class UploadExchangeRateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRatesService: ExchangeRatesService
  ) {}

  async ensureUsdKrwRates(batchId: string, metricDates: Date[]) {
    if (metricDates.length === 0) {
      return;
    }

    try {
      await this.exchangeRatesService.ensureUsdKrwRatesForDates(metricDates);
    } catch (error) {
      const message = exchangeRateErrorMessage(error);
      await this.prisma.uploadRowError.create({
        data: {
          uploadBatchId: batchId,
          severity: "ERROR",
          errorCode: "EXCHANGE_RATE_SYNC_FAILED",
          message
        }
      });
      await this.prisma.uploadBatch.update({
        where: { id: batchId },
        data: { status: UploadStatus.FAILED, errorCount: 1, validatedAt: new Date() }
      });
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        code: "EXCHANGE_RATE_SYNC_FAILED",
        message: "업로드 날짜의 USD/KRW 환율을 확보하지 못했습니다.",
        details: message
      });
    }
  }
}

function exchangeRateErrorMessage(error: unknown) {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === "object" && response && "message" in response) {
      return String((response as { message?: unknown }).message);
    }
  }
  return error instanceof Error ? error.message : "환율 확보 중 알 수 없는 오류가 발생했습니다.";
}
