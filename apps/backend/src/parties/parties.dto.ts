import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AddressType, PartyRoleType, PartyType, PhoneKind, ScoreLevel } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

export class PartyPhoneInputDto {
  @IsEnum(PhoneKind)
  kind: PhoneKind = PhoneKind.MOBILE;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  value: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  extension?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  notes?: string;
}

export class ContactPhoneInputDto {
  @IsEnum(PhoneKind)
  kind: PhoneKind = PhoneKind.MOBILE;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  value: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class CreatePartyDto {
  @IsEnum(PartyType)
  type: PartyType;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  nameFa: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  internalCode?: string;

  // COMPANY fields
  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  nationalId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  economicCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  website?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(128)
  email?: string;

  // PERSON fields
  @IsOptional()
  @IsString()
  @MaxLength(64)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  gender?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  nationalCode?: string;

  // CRM ownership — defaults to the creating user when omitted.
  @IsOptional()
  @IsUUID('4')
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PartyPhoneInputDto)
  phones?: PartyPhoneInputDto[];

  @IsOptional()
  @IsArray()
  @IsEnum(PartyRoleType, { each: true })
  roles?: PartyRoleType[];
}

export class UpdatePartyDto {
  /** Required: optimistic-locking check against the current party version. */
  @IsInt()
  @Type(() => Number)
  version: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameEn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  internalCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  nationalId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  economicCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  website?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(128)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  firstName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  gender?: string | null;

  @IsOptional()
  @IsDateString()
  birthDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  nationalCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  /**
   * Owner reassignment. Requires the `parties.owner.change` permission in
   * addition to `parties.edit`; writes a dedicated OWNER_CHANGED audit +
   * timeline event.
   */
  @IsOptional()
  @IsUUID('4')
  ownerUserId?: string | null;
}

export class CheckDuplicateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  mobile?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  nameFa?: string;

  @IsOptional()
  @IsUUID('4')
  excludePartyId?: string;
}

export class PartyQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(PartyType)
  type?: PartyType;

  @IsOptional()
  @IsEnum(PartyRoleType)
  role?: PartyRoleType;

  @IsOptional()
  @IsUUID('4')
  ownerUserId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  archived: boolean = false;

  @IsOptional()
  @IsEnum(ScoreLevel)
  scoreLevel?: ScoreLevel;
}

export class AddRoleDto {
  @IsEnum(PartyRoleType)
  role: PartyRoleType;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  notes?: string;
}

export class AddPartyPhoneDto {
  @IsEnum(PhoneKind)
  kind: PhoneKind = PhoneKind.MOBILE;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  value: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  extension?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  notes?: string;
}

export class CreateContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  position?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(128)
  email?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContactPhoneInputDto)
  phones?: ContactPhoneInputDto[];
}

export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  position?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(128)
  email?: string | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class CreateAddressDto {
  @IsOptional()
  @IsEnum(AddressType)
  type?: AddressType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  postalCode?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  line: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsEnum(AddressType)
  type?: AddressType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  province?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  line?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class AssignOwnerDto {
  @IsUUID('4')
  userId: string;
}

export class AddFinancialResponsibilityDto {
  @IsUUID('4')
  responsiblePartyId: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

export class TimelineQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number = 50;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeHidden?: boolean = false;
}
