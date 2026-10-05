import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class QueueJobQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['PENDING', 'SCHEDULED', 'PROCESSING', 'RETRYING', 'FAILED', 'SUCCEEDED', 'CANCELLED'])
  status?:
    | 'PENDING'
    | 'SCHEDULED'
    | 'PROCESSING'
    | 'RETRYING'
    | 'FAILED'
    | 'SUCCEEDED'
    | 'CANCELLED';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  jobType?: string;
}
