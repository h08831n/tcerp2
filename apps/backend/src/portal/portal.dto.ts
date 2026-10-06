import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreatePortalAccountDto {
  /** Party this portal account belongs to (Phase 3 FK target). */
  @IsUUID()
  partyId!: string;

  /** Website user linked to the party; unique per company when present. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  websiteUserId?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(32)
  verifiedMobile!: string;

  @IsOptional()
  @IsIn(['PENDING', 'ACTIVE', 'SUSPENDED'])
  status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
}

export class PortalAccountQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'ACTIVE', 'SUSPENDED'])
  status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
}
