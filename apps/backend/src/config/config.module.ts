import { Global, Module } from '@nestjs/common';
import { loadConfig, CONFIG } from './configuration';

export { CONFIG };

/**
 * Global config module. The value is zod-validated once (fail fast) and
 * shared through the whole application.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: loadConfig }],
  exports: [CONFIG],
})
export class ConfigModule {}
