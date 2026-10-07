import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PublishChannel } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

export class PublishChannelEntryDto {
  @IsEnum(PublishChannel)
  channel!: PublishChannel;

  /** Channel id / chat id / webhook target; empty = the channel default. */
  @IsOptional()
  @IsString()
  destination?: string;

  /** Publishing template code override (else the channel's active template). */
  @IsOptional()
  @IsString()
  templateCode?: string;
}

export class CreatePublishBatchDto {
  /** `YYYY-MM-DD`; defaults to today. */
  @IsOptional()
  @IsString()
  priceDate?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PublishChannelEntryDto)
  channels!: PublishChannelEntryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  variantIds?: string[];

  /** Alternative to variantIds: all variants of the category with a price that day. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class PublishBatchQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(['PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsEnum(PublishChannel)
  channel?: PublishChannel;

  @IsOptional()
  @IsString()
  date?: string;
}

export class RetryPublishItemDto {
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class CreatePublishingTemplateDto {
  @IsEnum(PublishChannel)
  channel!: PublishChannel;

  @IsString()
  code!: string;

  @IsString()
  nameFa!: string;

  @IsString()
  bodyTemplate!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePublishingTemplateDto {
  @IsOptional()
  @IsEnum(PublishChannel)
  channel?: PublishChannel;

  @IsOptional()
  @IsString()
  nameFa?: string;

  @IsOptional()
  @IsString()
  bodyTemplate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RenderPreviewDto {
  /** Template to render (else bodyTemplate must be given). */
  @IsOptional()
  @IsUUID()
  templateId?: string;

  /** Ad-hoc body (takes precedence only when templateId is absent). */
  @IsOptional()
  @IsString()
  bodyTemplate?: string;

  @IsOptional()
  @IsEnum(PublishChannel)
  channel?: PublishChannel;

  @IsUUID()
  variantId!: string;

  @IsOptional()
  @IsString()
  date?: string;
}
