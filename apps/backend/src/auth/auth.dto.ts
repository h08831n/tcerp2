import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  identifier!: string; // username or email

  @IsString()
  @MinLength(1)
  password!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  // Strict Iranian-mobile validation happens in the service
  // (normalizeIranMobile: prefixes +98/0098/9…, Persian digits, canonical
  // 09XXXXXXXXX) — the DTO only bounds the raw input size.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsOptional()
  @IsIn(['fa', 'en'])
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  // Either an external http(s) image URL or an internal file path served by
  // the auth avatar route (POST /auth/avatar sets this). Empty string clears.
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^(https?:\/\/[^\s]+|\/api\/[\w\-./]+)?$/, {
    message: 'avatarUrl must be an http(s) URL or an internal /api/ file path',
  })
  avatarUrl?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
