import { IsNumber, Max, Min } from "class-validator";

export class UpdateCoupangManualPurchaseVendorFeeDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999_999.99)
  valueJson!: number;
}
