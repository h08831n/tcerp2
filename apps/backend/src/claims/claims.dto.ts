import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateClaimDto {
  @IsIn(['CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT'])
  direction!: 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT';

  @IsUUID()
  partyId!: string;

  @IsOptional()
  @IsUUID()
  salesDocumentId?: string;

  @IsOptional()
  @IsUUID()
  purchaseDocumentId?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class RejectClaimDto {
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class MatchClaimDto {
  @IsOptional()
  @IsUUID()
  receiptId?: string;

  @IsOptional()
  @IsUUID()
  paymentId?: string;
}
