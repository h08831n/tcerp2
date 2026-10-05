import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  bankName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBankAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateBankTransferDto {
  @IsUUID()
  sourceBankAccountId!: string;

  @IsUUID()
  destinationBankAccountId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;

  @IsOptional()
  @IsDateString()
  transferDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateReceiptDto {
  @IsUUID()
  bankAccountId!: string;

  @IsOptional()
  @IsUUID()
  partyId?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreatePaymentDto extends CreateReceiptDto {}

export class RegisterCheckDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  checkNumber!: string;

  @IsOptional()
  @IsUUID()
  partyId?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsDateString()
  dueDate!: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ClearCheckDto {
  @IsUUID()
  bankAccountId!: string;
}

export class CheckTransitionDto {
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
