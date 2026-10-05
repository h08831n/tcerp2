import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'tcerp:isPublic';

/** Marks a route as public (skips JwtAuthGuard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
